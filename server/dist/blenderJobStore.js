import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sweepExpiredJobDirectories } from './jobDirectorySweep.js';
const BLENDER_SCRIPT = String.raw `
import argparse, json, math, os, sys
import bpy
from mathutils import Vector

script_args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument('--manifest', required=True)
args = parser.parse_args(script_args)
with open(args.manifest, 'r', encoding='utf-8') as handle:
    manifest = json.load(handle)

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
try:
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
except TypeError:
    scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 1280
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'

def hex_color(value):
    value = str(value or '#202225').lstrip('#')
    if len(value) != 6: value = '202225'
    return tuple(int(value[i:i+2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)

scene.world.color = hex_color(manifest.get('scene', {}).get('backgroundColor'))[:3]
panorama_path = manifest.get('panoramaPath')
if panorama_path and os.path.exists(panorama_path):
    scene.world.use_nodes = True
    nodes = scene.world.node_tree.nodes
    links = scene.world.node_tree.links
    nodes.clear()
    output = nodes.new('ShaderNodeOutputWorld')
    background = nodes.new('ShaderNodeBackground')
    environment = nodes.new('ShaderNodeTexEnvironment')
    environment.image = bpy.data.images.load(panorama_path, check_existing=True)
    texcoord = nodes.new('ShaderNodeTexCoord')
    mapping = nodes.new('ShaderNodeMapping')
    mapping.inputs['Rotation'].default_value[2] = float(manifest.get('scene', {}).get('panoramaYaw', 0))
    links.new(texcoord.outputs['Generated'], mapping.inputs['Vector'])
    links.new(mapping.outputs['Vector'], environment.inputs['Vector'])
    links.new(environment.outputs['Color'], background.inputs['Color'])
    links.new(background.outputs['Background'], output.inputs['Surface'])

for item in manifest.get('objects', []):
    if not item.get('visible', True): continue
    before = set(bpy.data.objects)
    source_path = item.get('sourcePath')
    if source_path and os.path.splitext(source_path)[1].lower() in ('.glb', '.gltf'):
        bpy.ops.import_scene.gltf(filepath=source_path)
    else:
        primitive = item.get('geometryType') or ('sphere' if item.get('kind') == 'character' else 'box')
        if primitive == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add()
        elif primitive == 'cylinder': bpy.ops.mesh.primitive_cylinder_add()
        elif primitive == 'torus': bpy.ops.mesh.primitive_torus_add()
        elif primitive in ('cone', 'pyramid'): bpy.ops.mesh.primitive_cone_add(vertices=4 if primitive == 'pyramid' else 32)
        else: bpy.ops.mesh.primitive_cube_add()
    created = [obj for obj in bpy.data.objects if obj not in before]
    roots = [obj for obj in created if obj.parent is None]
    transform = item.get('transform', {})
    for obj in roots:
        obj.location = transform.get('position', [0, 0, 0])
        obj.rotation_euler = transform.get('rotation', [0, 0, 0])
        obj.scale = transform.get('scale', [1, 1, 1])
        obj.name = str(item.get('name') or item.get('id') or 'Object')[:63]

camera_data = None
for candidate in manifest.get('cameras', []):
    if candidate.get('id') == manifest.get('activeCameraId'):
        camera_data = candidate
        break
if camera_data is None and manifest.get('cameras'):
    camera_data = manifest['cameras'][0]
camera_block = bpy.data.cameras.new('MK Camera')
camera = bpy.data.objects.new('MK Camera', camera_block)
scene.collection.objects.link(camera)
if camera_data:
    transform = camera_data.get('transform', {})
    camera.location = transform.get('position', [8, 6, 8])
    target = Vector(camera_data.get('target', [0, 0, 0]))
    camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera_block.angle = math.radians(float(camera_data.get('fov', 50)))
else:
    camera.location = (8, 6, 8)
    camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = camera

light_data = bpy.data.lights.new(name='MK Key', type='AREA')
light_data.energy = 1200
light_data.shape = 'DISK'
light_data.size = 6
light = bpy.data.objects.new(name='MK Key', object_data=light_data)
scene.collection.objects.link(light)
light.location = (4, 8, 6)

scene.render.filepath = manifest['renderPath']
bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath=manifest['glbPath'], export_format='GLB')
`;
const DIRECTOR_OBJECT_KINDS = new Set(['character', 'scene', 'prop', 'camera', 'panorama']);
const GEOMETRY_TYPES = new Set(['box', 'sphere', 'cylinder', 'torus', 'cone', 'pyramid']);
const PANORAMA_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.hdr', '.exr']);
const MAX_OBJECTS = 5000;
const MAX_CAMERAS = 128;
const MAX_ASSETS = 5000;
const requireRecord = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label} 必须是对象`);
    return value;
};
const requireArray = (value, label, maxLength) => {
    if (!Array.isArray(value))
        throw new Error(`${label} 必须是数组`);
    if (value.length > maxLength)
        throw new Error(`${label} 最多允许 ${maxLength} 项`);
    return value;
};
const finiteNumber = (value, label, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的有限数值`);
    }
    return value;
};
const finiteTuple = (value, label, min, max) => {
    if (!Array.isArray(value) || value.length !== 3)
        throw new Error(`${label} 必须是三维向量`);
    return [
        finiteNumber(value[0], `${label}[0]`, min, max),
        finiteNumber(value[1], `${label}[1]`, min, max),
        finiteNumber(value[2], `${label}[2]`, min, max)
    ];
};
const sanitizeTransform = (value, label) => {
    const transform = requireRecord(value, label);
    return {
        position: finiteTuple(transform.position, `${label}.position`, -1000000, 1000000),
        rotation: finiteTuple(transform.rotation, `${label}.rotation`, -10000, 10000),
        scale: finiteTuple(transform.scale, `${label}.scale`, -10000, 10000)
    };
};
const safeText = (value, fallback, maxLength) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : fallback);
const resolveControlledSource = (url, roots) => {
    if (!url)
        return undefined;
    const root = roots.find((candidate) => url.startsWith(`${candidate.prefix}/`));
    if (!root)
        return undefined;
    let relative;
    try {
        relative = decodeURIComponent(url.slice(root.prefix.length + 1));
    }
    catch {
        return undefined;
    }
    if (!relative || relative.includes('/') || relative.includes('\\') || relative.includes('..') || path.basename(relative) !== relative)
        return undefined;
    const resolvedRoot = path.resolve(root.rootDir);
    const resolved = path.resolve(resolvedRoot, decodeURIComponent(relative));
    return resolved.startsWith(`${resolvedRoot}${path.sep}`) && fs.existsSync(resolved) ? resolved : undefined;
};
const detectBlenderPath = (configured) => {
    if (configured) {
        const resolved = path.resolve(configured);
        return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
    }
    const candidates = process.platform === 'win32'
        ? [
            'D:/Blender/blender.exe',
            'C:/Program Files/Blender Foundation/Blender 4.5/blender.exe',
            'C:/Program Files/Blender Foundation/Blender 4.4/blender.exe',
            'C:/Program Files/Blender Foundation/Blender 4.3/blender.exe',
            'C:/Program Files/Blender Foundation/Blender 4.2/blender.exe'
        ]
        : process.platform === 'darwin'
            ? ['/Applications/Blender.app/Contents/MacOS/Blender']
            : ['/usr/bin/blender', '/usr/local/bin/blender'];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
};
export const createBlenderJobStore = ({ jobsDir, persistDerivedHistoryAsset, persistDirectorModelFile, sourceRoots, resolveLinkedSource, executablePath = process.env.MK_BLENDER_PATH, timeoutMs = 10 * 60 * 1000, spawnProcess = (command, args, options) => spawn(command, args, options) }) => {
    fs.mkdirSync(jobsDir, { recursive: true });
    sweepExpiredJobDirectories(jobsDir, 24 * 60 * 60 * 1000);
    const blenderPath = detectBlenderPath(executablePath);
    const jobs = new Map();
    const view = (job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        ...(job.message ? { message: job.message } : {}),
        ...(job.renderAsset ? { renderAsset: job.renderAsset } : {}),
        ...(job.glbUrl ? { glbUrl: job.glbUrl } : {}),
        ...(job.directorModelAssetId ? { directorModelAssetId: job.directorModelAssetId } : {})
    });
    const update = (job, patch) => {
        Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    };
    const prepareManifest = (snapshot, directory) => {
        if (snapshot.version !== 1)
            throw new Error('仅支持 version 1 的导演台场景快照');
        const scene = requireRecord(snapshot.scene, 'scene');
        const assets = requireArray(snapshot.assets, 'assets', MAX_ASSETS).map((value, index) => requireRecord(value, `assets[${index}]`));
        const sourceById = new Map(assets.flatMap((asset, index) => {
            const id = safeText(asset.id, '', 160);
            if (!id)
                throw new Error(`assets[${index}].id 不能为空`);
            const assetUrl = typeof asset.url === 'string' ? asset.url : undefined;
            const sourcePath = assetUrl
                ? resolveLinkedSource?.(assetUrl) ?? resolveControlledSource(assetUrl, sourceRoots)
                : undefined;
            return id && sourcePath ? [[id, sourcePath]] : [];
        }));
        const objects = requireArray(snapshot.objects, 'objects', MAX_OBJECTS).flatMap((value, index) => {
            const item = requireRecord(value, `objects[${index}]`);
            const kind = safeText(item.kind, 'prop', 32);
            if (!DIRECTOR_OBJECT_KINDS.has(kind))
                throw new Error(`objects[${index}].kind 不受支持`);
            if (kind === 'camera' || kind === 'panorama')
                return [];
            const geometryType = item.geometryType === undefined ? undefined : safeText(item.geometryType, '', 32);
            if (geometryType !== undefined && !GEOMETRY_TYPES.has(geometryType)) {
                throw new Error(`objects[${index}].geometryType 不受支持`);
            }
            return [{
                    id: safeText(item.id, crypto.randomUUID(), 160),
                    name: safeText(item.name, 'Object', 120),
                    kind,
                    visible: item.visible !== false,
                    geometryType,
                    transform: sanitizeTransform(item.transform, `objects[${index}].transform`),
                    sourcePath: typeof item.assetRefId === 'string' ? sourceById.get(item.assetRefId) : undefined
                }];
        });
        const cameras = requireArray(snapshot.cameras, 'cameras', MAX_CAMERAS).map((value, index) => {
            const camera = requireRecord(value, `cameras[${index}]`);
            return {
                id: safeText(camera.id, `camera-${index + 1}`, 160),
                name: safeText(camera.name, `Camera ${index + 1}`, 120),
                fov: finiteNumber(camera.fov, `cameras[${index}].fov`, 1, 179),
                transform: sanitizeTransform(camera.transform, `cameras[${index}].transform`),
                target: finiteTuple(camera.target, `cameras[${index}].target`, -1000000, 1000000)
            };
        });
        const backgroundColor = scene.backgroundColor === undefined ? '#202225' : safeText(scene.backgroundColor, '', 16);
        if (!/^#[0-9a-f]{6}$/i.test(backgroundColor))
            throw new Error('scene.backgroundColor 必须是六位十六进制颜色');
        const panoramaYaw = scene.panoramaYaw === undefined
            ? 0
            : finiteNumber(scene.panoramaYaw, 'scene.panoramaYaw', -10000, 10000);
        const panoramaSource = typeof snapshot.panoramaAssetId === 'string'
            ? sourceById.get(snapshot.panoramaAssetId)
            : undefined;
        return {
            scene: { backgroundColor, panoramaYaw },
            panoramaPath: panoramaSource && PANORAMA_EXTENSIONS.has(path.extname(panoramaSource).toLowerCase()) ? panoramaSource : undefined,
            objects,
            cameras,
            activeCameraId: typeof snapshot.activeCameraId === 'string' && cameras.some((camera) => camera.id === snapshot.activeCameraId)
                ? snapshot.activeCameraId
                : null,
            renderPath: path.join(directory, 'render.png'),
            glbPath: path.join(directory, 'scene.glb')
        };
    };
    return {
        getStatus: () => ({ available: Boolean(blenderPath), configured: Boolean(executablePath) }),
        listJobs: () => Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view),
        getJob: (id) => {
            const job = jobs.get(id);
            return job ? view(job) : null;
        },
        getOutputPath: (id, kind) => {
            const job = jobs.get(id);
            if (!job || job.status !== 'completed')
                return null;
            const filePath = path.join(job.directory, kind === 'render' ? 'render.png' : 'scene.glb');
            return fs.existsSync(filePath) ? filePath : null;
        },
        createJob(snapshot, scope) {
            if (!blenderPath)
                throw new Error('未找到 Blender，请配置 MK_BLENDER_PATH');
            if (!scope.projectId.trim() || !scope.canvasId.trim())
                throw new Error('缺少当前项目或画布 ID');
            const id = `blender-${crypto.randomUUID()}`;
            const directory = path.join(jobsDir, id);
            const manifest = prepareManifest(snapshot, directory);
            fs.mkdirSync(directory, { recursive: true });
            const manifestPath = path.join(directory, 'manifest.json');
            const scriptPath = path.join(directory, 'render_scene.py');
            fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
            fs.writeFileSync(scriptPath, BLENDER_SCRIPT, 'utf8');
            const timestamp = new Date().toISOString();
            const job = { id, status: 'queued', createdAt: timestamp, updatedAt: timestamp, directory, log: '', scope };
            jobs.set(id, job);
            const child = spawnProcess(blenderPath, ['--background', '--python-exit-code', '1', '--python', scriptPath, '--', '--manifest', manifestPath], {
                cwd: directory,
                windowsHide: true,
                stdio: 'pipe'
            });
            job.process = child;
            update(job, { status: 'running' });
            const appendLog = (chunk) => { job.log = `${job.log}${chunk.toString('utf8')}`.slice(-64 * 1024); };
            child.stdout.on('data', appendLog);
            child.stderr.on('data', appendLog);
            job.timeout = setTimeout(() => {
                if (job.status !== 'running')
                    return;
                child.kill();
                update(job, { status: 'timeout', message: 'Blender 渲染超时' });
            }, timeoutMs);
            child.once('error', (error) => {
                if (job.timeout)
                    clearTimeout(job.timeout);
                update(job, { status: 'failed', message: error.message });
            });
            child.once('exit', (code) => {
                if (job.timeout)
                    clearTimeout(job.timeout);
                delete job.process;
                if (job.status !== 'running')
                    return;
                if (code !== 0) {
                    update(job, { status: 'failed', message: job.log.trim().slice(-1000) || `Blender exited with code ${code}` });
                    return;
                }
                const renderPath = path.join(directory, 'render.png');
                const glbPath = path.join(directory, 'scene.glb');
                if (!fs.existsSync(renderPath) || !fs.existsSync(glbPath)) {
                    update(job, { status: 'failed', message: 'Blender 未生成预期的 PNG/GLB 文件' });
                    return;
                }
                const renderTask = persistDerivedHistoryAsset({
                    filePath: renderPath,
                    fileName: `Blender-${id}.png`,
                    kind: 'image',
                    scope: job.scope,
                    source: 'Blender 渲染',
                    metadata: { operation: 'blender-still-render' }
                });
                const modelTask = persistDirectorModelFile
                    ? persistDirectorModelFile(glbPath, `Blender-${id}.glb`)
                    : Promise.resolve({ id: '', fileUrl: `/api/blender/jobs/${encodeURIComponent(id)}/files/glb` });
                void Promise.all([renderTask, modelTask]).then(([asset, modelAsset]) => update(job, {
                    status: 'completed',
                    renderAsset: {
                        id: asset.id,
                        name: asset.name,
                        kind: 'image',
                        fileUrl: asset.previewUrl,
                        ...(asset.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl } : {})
                    },
                    glbUrl: modelAsset.fileUrl,
                    ...(modelAsset.id ? { directorModelAssetId: modelAsset.id } : {})
                })).catch((error) => update(job, { status: 'failed', message: error instanceof Error ? error.message : 'Blender 结果入库失败' }));
            });
            return view(job);
        },
        cancelJob(id) {
            const job = jobs.get(id);
            if (!job)
                return null;
            if (job.status === 'queued' || job.status === 'running') {
                job.process?.kill();
                if (job.timeout)
                    clearTimeout(job.timeout);
                update(job, { status: 'cancelled', message: 'Blender 任务已取消' });
            }
            return view(job);
        },
        close() {
            jobs.forEach((job) => {
                if (job.status === 'running')
                    job.process?.kill();
                if (job.timeout)
                    clearTimeout(job.timeout);
            });
        }
    };
};
