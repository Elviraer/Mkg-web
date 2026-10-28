import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sweepExpiredJobDirectories } from './jobDirectorySweep.js';
const VIDEO_SCRIPT = String.raw `
import argparse, json, math, os, sys
import bpy
from mathutils import Vector, Quaternion

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
scene.render.resolution_x = int(manifest['resolution'][0])
scene.render.resolution_y = int(manifest['resolution'][1])
scene.render.resolution_percentage = 100
scene.render.fps = int(manifest.get('sourceFps', 24))
scene.frame_start = 0
scene.frame_end = int(manifest['durationFrames']) - 1
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = manifest['framePrefix']

def hex_color(value):
    value = str(value or '#202225').lstrip('#')
    if len(value) != 6: value = '202225'
    return tuple(int(value[i:i+2], 16) / 255.0 for i in (0, 2, 4)) + (1.0,)

scene.world.color = hex_color(manifest.get('backgroundColor'))[:3]
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
    links.new(environment.outputs['Color'], background.inputs['Color'])
    links.new(background.outputs['Background'], output.inputs['Surface'])

def import_objects(source_path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=source_path)
    return [obj for obj in bpy.data.objects if obj not in before]

def parent_roots(created, parent):
    for obj in created:
        if obj.parent is None:
            obj.parent = parent

def apply_transform(obj, transform):
    obj.location = transform.get('position', [0, 0, 0])
    obj.rotation_euler = transform.get('rotation', [0, 0, 0])
    obj.scale = transform.get('scale', [1, 1, 1])

for item in manifest.get('objects', []):
    container = bpy.data.objects.new(str(item.get('name') or item.get('id'))[:63], None)
    scene.collection.objects.link(container)
    apply_transform(container, item.get('transform', {}))
    if item.get('sourcePath'):
        created = import_objects(item['sourcePath'])
    else:
        before = set(bpy.data.objects)
        primitive = item.get('geometryType') or 'box'
        if primitive == 'sphere': bpy.ops.mesh.primitive_uv_sphere_add()
        elif primitive == 'cylinder': bpy.ops.mesh.primitive_cylinder_add()
        elif primitive == 'torus': bpy.ops.mesh.primitive_torus_add()
        elif primitive in ('cone', 'pyramid'): bpy.ops.mesh.primitive_cone_add(vertices=4 if primitive == 'pyramid' else 32)
        else: bpy.ops.mesh.primitive_cube_add()
        created = [obj for obj in bpy.data.objects if obj not in before]
    parent_roots(created, container)
    target_armature = next((obj for obj in created if obj.type == 'ARMATURE'), None)
    clips = item.get('motionClips', [])
    if target_armature and clips:
        target_armature.animation_data_create()
        target_armature.animation_data.action = None
        while target_armature.animation_data.nla_tracks:
            target_armature.animation_data.nla_tracks.remove(target_armature.animation_data.nla_tracks[0])
        track = target_armature.animation_data.nla_tracks.new()
        track.name = 'MK Motion Track'
        actions = {}
        for clip in clips:
            motion_path = clip['motionPath']
            action = actions.get(motion_path)
            if action is None:
                imported = import_objects(motion_path)
                imported_armature = next((obj for obj in imported if obj.type == 'ARMATURE'), None)
                if imported_armature and imported_armature.animation_data and imported_armature.animation_data.action:
                    action = imported_armature.animation_data.action.copy()
                    action.name = 'MK-' + str(len(actions) + 1)
                    actions[motion_path] = action
                for obj in imported:
                    bpy.data.objects.remove(obj, do_unlink=True)
            if action is None:
                continue
            source_fps = float(clip['sourceFps'])
            action_start = float(clip['inFrame']) * 24.0 / source_fps
            action_end = float(clip['outFrame']) * 24.0 / source_fps
            strip = track.strips.new(str(clip['id'])[:63], int(clip['startFrame']), action)
            strip.action_frame_start = action_start
            strip.action_frame_end = action_end
            strip.frame_end = float(clip['startFrame']) + max(1.0, (action_end - action_start) / float(clip['speed']))
            strip.blend_in = float(clip.get('blendInFrames', 0))
            strip.blend_out = float(clip.get('blendOutFrames', 0))
            strip.extrapolation = 'NOTHING'

cameras = {}
for item in manifest.get('cameras', []):
    data = bpy.data.cameras.new(str(item['name'])[:63])
    camera = bpy.data.objects.new(str(item['name'])[:63], data)
    scene.collection.objects.link(camera)
    camera.location = item['transform']['position']
    target = Vector(item['target'])
    camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
    data.angle = math.radians(float(item['fov']))
    cameras[item['id']] = camera

for clip in manifest.get('cameraMotionClips', []):
    camera = cameras.get(clip['cameraId'])
    if not camera or not os.path.exists(clip['skeletonPath']):
        continue
    with open(clip['skeletonPath'], 'r', encoding='utf-8') as handle:
        skeleton = json.load(handle)
    motion_frames = skeleton.get('cameraMotion', {}).get('frames', [])
    if not motion_frames:
        continue
    base_location = camera.location.copy()
    base_target = Vector(clip['target'])
    base_rotation = (base_target - base_location).to_track_quat('-Z', 'Y')
    base_angle = math.radians(float(clip['fov']))
    source_fps = float(clip['sourceFps'])
    timeline_fps = float(manifest.get('sourceFps', 24))
    camera.rotation_mode = 'QUATERNION'
    for source_frame in range(int(clip['inFrame']), min(int(clip['outFrame']), len(motion_frames))):
        sample = motion_frames[source_frame]
        timeline_frame = int(round(float(clip['startFrame']) + (source_frame - float(clip['inFrame'])) / source_fps * timeline_fps / float(clip['speed'])))
        pan_x = max(-0.35, min(0.35, float(sample.get('panX', 0.0))))
        pan_y = max(-0.35, min(0.35, float(sample.get('panY', 0.0))))
        roll = max(-0.35, min(0.35, float(sample.get('roll', 0.0))))
        yaw = pan_x * float(clip['fov']) * math.pi / 180.0
        pitch = -pan_y * float(clip['fov']) * math.pi / 180.0
        rotation = Quaternion((0.0, 0.0, 1.0), yaw) @ base_rotation
        right = rotation @ Vector((1.0, 0.0, 0.0))
        rotation = Quaternion(right, pitch) @ rotation
        forward = rotation @ Vector((0.0, 0.0, -1.0))
        rotation = Quaternion(forward, roll) @ rotation
        camera.location = base_location
        camera.rotation_quaternion = rotation
        camera.keyframe_insert(data_path='location', frame=timeline_frame)
        camera.keyframe_insert(data_path='rotation_quaternion', frame=timeline_frame)
        target_angle = base_angle / max(0.5, float(sample.get('zoom', 1.0)))
        camera.data.lens = camera.data.sensor_width / (2.0 * math.tan(target_angle / 2.0))
        camera.data.keyframe_insert(data_path='lens', frame=timeline_frame)

camera_clips = manifest.get('cameraClips', [])
if camera_clips:
    for clip in camera_clips:
        camera = cameras.get(clip['cameraId'])
        if camera:
            marker = scene.timeline_markers.new('MK Camera ' + str(clip['startFrame']), frame=int(clip['startFrame']))
            marker.camera = camera
    scene.camera = cameras.get(camera_clips[0]['cameraId'])
elif cameras:
    scene.camera = cameras.get(manifest.get('activeCameraId')) or next(iter(cameras.values()))

light_data = bpy.data.lights.new(name='MK Key', type='AREA')
light_data.energy = 1200
light_data.shape = 'DISK'
light_data.size = 6
light = bpy.data.objects.new(name='MK Key', object_data=light_data)
scene.collection.objects.link(light)
light.location = (4, 8, 6)

os.makedirs(os.path.dirname(manifest['framePrefix']), exist_ok=True)
def mk_report_progress(current_scene):
    print('MK_VIDEO_PROGRESS frame=' + str(current_scene.frame_current) + ' total=' + str(manifest['durationFrames']), flush=True)
bpy.app.handlers.render_write.append(mk_report_progress)
bpy.ops.render.render(animation=True)
print('MK_VIDEO_RENDER_OK frames=' + str(manifest['durationFrames']))
`;
const requireRecord = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${label} 必须是对象`);
    return value;
};
const requireArray = (value, label, max) => {
    if (!Array.isArray(value) || value.length > max)
        throw new Error(`${label} 必须是最多 ${max} 项的数组`);
    return value;
};
const finite = (value, label, min, max) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
        throw new Error(`${label} 数值无效`);
    return value;
};
const tuple = (value, label) => {
    if (!Array.isArray(value) || value.length !== 3)
        throw new Error(`${label} 必须是三维向量`);
    return [finite(value[0], `${label}[0]`, -1e6, 1e6), finite(value[1], `${label}[1]`, -1e6, 1e6), finite(value[2], `${label}[2]`, -1e6, 1e6)];
};
const text = (value, fallback, max = 160) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
const resolveControlledSource = (url, roots) => {
    if (typeof url !== 'string')
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
    const rootPath = path.resolve(root.rootDir);
    const resolved = path.resolve(rootPath, relative);
    return resolved.startsWith(`${rootPath}${path.sep}`) && fs.existsSync(resolved) ? resolved : undefined;
};
const detectExecutable = (configured, candidates, commandName) => {
    if (configured) {
        const resolved = path.resolve(configured);
        return fs.existsSync(resolved) ? resolved : null;
    }
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found)
        return found;
    if (commandName) {
        const probe = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [commandName], { encoding: 'utf8', windowsHide: true });
        const first = probe.status === 0 ? probe.stdout.split(/\r?\n/).find(Boolean) : undefined;
        return first ? first.trim() : null;
    }
    return null;
};
const ASPECT_RATIOS = {
    '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '3:4': 3 / 4, '21:9': 21 / 9, auto: 16 / 9
};
const RESOLUTION_BASE = {
    '720p': 720, '1080p': 1080, '1440p': 1440
};
const even = (value) => Math.max(2, Math.round(value / 2) * 2);
const parseExportSettings = (value) => {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        resolution: input.resolution === '720p' || input.resolution === '1440p' ? input.resolution : '1080p',
        frameRate: input.frameRate === 25 || input.frameRate === 30 ? input.frameRate : 24,
        codec: input.codec === 'h265' ? 'h265' : 'h264',
        quality: input.quality === 'high' || input.quality === 'compact' ? input.quality : 'balanced'
    };
};
const resolveResolution = (aspectRatio, resolution) => {
    const ratio = ASPECT_RATIOS[aspectRatio] ?? ASPECT_RATIOS.auto;
    const base = RESOLUTION_BASE[resolution];
    return ratio >= 1 ? [even(base * ratio), base] : [base, even(base / ratio)];
};
export const createDirectorVideoExportJobStore = ({ appDatabase, jobsDir, motionAssetsDir, persistDerivedHistoryAsset, targetGlbPath, sourceRoots, resolveLinkedSource, blenderPath = process.env.MK_BLENDER_PATH, ffmpegPath = process.env.MK_FFMPEG_PATH, timeoutMs = 60 * 60 * 1000, spawnProcess = (command, args, options) => spawn(command, args, options) }) => {
    fs.mkdirSync(jobsDir, { recursive: true });
    sweepExpiredJobDirectories(jobsDir, 24 * 60 * 60 * 1000);
    const previewUploadsDir = path.join(jobsDir, 'preview-uploads');
    fs.mkdirSync(previewUploadsDir, { recursive: true });
    const blender = detectExecutable(blenderPath, process.platform === 'win32' ? ['D:/Blender/blender.exe'] : ['/usr/bin/blender'], 'blender');
    const ffmpeg = detectExecutable(ffmpegPath, [], 'ffmpeg');
    const targetGlb = path.resolve(targetGlbPath);
    const motionRoot = path.resolve(motionAssetsDir);
    const jobs = new Map();
    const view = (job) => ({
        id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt,
        ...(job.progress !== undefined ? { progress: job.progress } : {}), ...(job.stage ? { stage: job.stage } : {}),
        ...(job.message ? { message: job.message } : {}), ...(job.videoAsset ? { videoAsset: job.videoAsset } : {})
    });
    const update = (job, patch) => Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    const cleanupTemporaryFiles = (directory) => {
        fs.rmSync(path.join(directory, 'frames'), { recursive: true, force: true });
        fs.rmSync(path.join(directory, 'preview-source.webm'), { force: true });
    };
    const motionFile = (assetId) => {
        const asset = appDatabase.getMotionAsset(assetId);
        if (!asset)
            throw new Error(`Motion Asset ${assetId} 不存在`);
        const resolved = path.resolve(motionRoot, asset.ue4File);
        const skeletonPath = asset.skeletonFile ? path.resolve(motionRoot, asset.skeletonFile) : null;
        if (!resolved.startsWith(`${motionRoot}${path.sep}`) || !fs.existsSync(resolved))
            throw new Error(`Motion Asset ${assetId} 文件不存在`);
        if (skeletonPath && (!skeletonPath.startsWith(`${motionRoot}${path.sep}`) || !fs.existsSync(skeletonPath))) {
            throw new Error(`Motion Asset ${assetId} 骨架文件不存在`);
        }
        return { path: resolved, skeletonPath, sourceFps: asset.sourceFps };
    };
    const prepareManifest = (snapshotValue, aspectRatioValue, settingsValue, directory) => {
        const snapshot = requireRecord(snapshotValue, 'snapshot');
        if (snapshot.version !== 2 && snapshot.version !== 3)
            throw new Error('视频导出仅支持 DirectorProject version 2/3');
        const sequence = requireRecord(snapshot.sequence, 'sequence');
        if (sequence.fps !== 24)
            throw new Error('sequence.fps 必须为 24');
        const durationFrames = Math.trunc(finite(sequence.durationFrames, 'sequence.durationFrames', 1, 24 * 60 * 60));
        const assets = requireArray(snapshot.assets, 'assets', 5000).map((value, index) => requireRecord(value, `assets[${index}]`));
        const sourcesById = new Map(assets.flatMap((asset) => {
            const id = text(asset.id, '');
            const assetUrl = typeof asset.url === 'string' ? asset.url : '';
            const source = assetUrl ? resolveLinkedSource?.(assetUrl) ?? resolveControlledSource(assetUrl, sourceRoots) : undefined;
            return id && source ? [[id, source]] : [];
        }));
        const tracks = requireArray(snapshot.characterTracks, 'characterTracks', 5000).map((value, index) => requireRecord(value, `characterTracks[${index}]`));
        const trackByCharacter = new Map(tracks.map((track) => [text(track.characterId, ''), track]));
        const objects = requireArray(snapshot.objects, 'objects', 5000).flatMap((value, index) => {
            const object = requireRecord(value, `objects[${index}]`);
            const kind = text(object.kind, 'prop', 32);
            if (kind === 'camera' || kind === 'panorama' || object.visible === false)
                return [];
            const transform = requireRecord(object.transform, `objects[${index}].transform`);
            const track = trackByCharacter.get(text(object.id, ''));
            const clips = track ? requireArray(track.clips, `characterTracks[${index}].clips`, 1000).map((clipValue, clipIndex) => {
                const clip = requireRecord(clipValue, `clips[${clipIndex}]`);
                const motion = motionFile(text(clip.motionAssetId, ''));
                return {
                    id: text(clip.id, `clip-${clipIndex}`), motionPath: motion.path, sourceFps: motion.sourceFps,
                    startFrame: Math.trunc(finite(clip.startFrame, 'clip.startFrame', 0, durationFrames)),
                    inFrame: Math.trunc(finite(clip.inFrame, 'clip.inFrame', 0, 240 * 30)),
                    outFrame: Math.trunc(finite(clip.outFrame, 'clip.outFrame', 1, 240 * 30)),
                    speed: finite(clip.speed, 'clip.speed', 0.1, 4),
                    blendInFrames: Math.trunc(finite(clip.blendInFrames, 'clip.blendInFrames', 0, 240 * 30)),
                    blendOutFrames: Math.trunc(finite(clip.blendOutFrames, 'clip.blendOutFrames', 0, 240 * 30))
                };
            }) : [];
            return [{
                    id: text(object.id, `object-${index}`), name: text(object.name, `Object ${index + 1}`), kind,
                    transform: { position: tuple(transform.position, 'transform.position'), rotation: tuple(transform.rotation, 'transform.rotation'), scale: tuple(transform.scale, 'transform.scale') },
                    sourcePath: kind === 'character' ? targetGlb : sourcesById.get(text(object.assetRefId, '')),
                    geometryType: typeof object.geometryType === 'string' ? object.geometryType : undefined,
                    motionClips: clips
                }];
        });
        const cameras = requireArray(snapshot.cameras, 'cameras', 128).map((value, index) => {
            const camera = requireRecord(value, `cameras[${index}]`);
            const transform = requireRecord(camera.transform, `cameras[${index}].transform`);
            return { id: text(camera.id, `camera-${index}`), name: text(camera.name, `Camera ${index + 1}`), fov: finite(camera.fov, 'camera.fov', 1, 179), transform: { position: tuple(transform.position, 'camera.position') }, target: tuple(camera.target, 'camera.target') };
        });
        const cameraTrack = requireRecord(snapshot.cameraTrack, 'cameraTrack');
        const cameraClips = requireArray(cameraTrack.clips, 'cameraTrack.clips', 1000).map((value, index) => {
            const clip = requireRecord(value, `cameraTrack.clips[${index}]`);
            return { cameraId: text(clip.cameraId, ''), startFrame: Math.trunc(finite(clip.startFrame, 'camera.startFrame', 0, durationFrames)), endFrame: Math.trunc(finite(clip.endFrame, 'camera.endFrame', 1, durationFrames)) };
        }).sort((a, b) => a.startFrame - b.startFrame);
        for (let index = 1; index < cameraClips.length; index += 1) {
            if (cameraClips[index].startFrame < cameraClips[index - 1].endFrame)
                throw new Error('镜头片段不允许重叠');
        }
        const cameraMotionClips = requireArray(cameraTrack.motionClips ?? [], 'cameraTrack.motionClips', 1000).map((value, index) => {
            const clip = requireRecord(value, `cameraTrack.motionClips[${index}]`);
            const motion = motionFile(text(clip.motionAssetId, ''));
            if (!motion.skeletonPath)
                throw new Error(`Motion Asset ${clip.motionAssetId} 不包含源视频运镜骨架`);
            const cameraId = text(clip.cameraId, '');
            const camera = cameras.find((item) => item.id === cameraId);
            if (!camera)
                throw new Error(`运镜片段摄像机 ${cameraId} 不存在`);
            return {
                cameraId,
                skeletonPath: motion.skeletonPath,
                sourceFps: motion.sourceFps,
                startFrame: Math.trunc(finite(clip.startFrame, 'cameraMotion.startFrame', 0, durationFrames)),
                inFrame: Math.trunc(finite(clip.inFrame, 'cameraMotion.inFrame', 0, 240 * 30)),
                outFrame: Math.trunc(finite(clip.outFrame, 'cameraMotion.outFrame', 1, 240 * 30)),
                speed: finite(clip.speed, 'cameraMotion.speed', 0.1, 4),
                target: camera.target,
                fov: camera.fov,
            };
        });
        const aspectRatio = typeof aspectRatioValue === 'string' && ASPECT_RATIOS[aspectRatioValue] ? aspectRatioValue : 'auto';
        const settings = parseExportSettings(settingsValue);
        const panoramaPath = typeof snapshot.panoramaAssetId === 'string' ? sourcesById.get(snapshot.panoramaAssetId) : undefined;
        return {
            durationFrames, sourceFps: 24, outputFps: settings.frameRate, codec: settings.codec, quality: settings.quality,
            resolution: resolveResolution(aspectRatio, settings.resolution), backgroundColor: requireRecord(snapshot.scene, 'scene').backgroundColor,
            panoramaPath,
            objects, cameras, cameraClips, cameraMotionClips, activeCameraId: typeof snapshot.activeCameraId === 'string' ? snapshot.activeCameraId : null,
            framePrefix: path.join(directory, 'frames', 'frame_')
        };
    };
    const fail = (job, message) => {
        cleanupTemporaryFiles(job.directory);
        update(job, { status: 'failed', message });
    };
    const persistVideo = (job, outputPath, fileName, source) => {
        update(job, { stage: '正在写入历史资产', progress: 0.99 });
        void persistDerivedHistoryAsset({
            filePath: outputPath,
            fileName,
            kind: 'video',
            scope: job.scope,
            source,
            metadata: { operation: 'director-video-export' }
        }).then((asset) => {
            if (job.timeout)
                clearTimeout(job.timeout);
            cleanupTemporaryFiles(job.directory);
            update(job, {
                status: 'completed',
                stage: '视频导出完成',
                progress: 1,
                videoAsset: {
                    id: asset.id,
                    name: asset.name,
                    kind: 'video',
                    fileUrl: asset.previewUrl,
                    ...(asset.thumbnailUrl ? { thumbnailUrl: asset.thumbnailUrl } : {})
                }
            });
        }).catch((error) => fail(job, error instanceof Error ? error.message : '视频结果入库失败'));
    };
    return {
        getStatus: () => ({
            available: Boolean(ffmpeg),
            quickAvailable: Boolean(ffmpeg),
            sceneAvailable: Boolean(blender && ffmpeg && fs.existsSync(targetGlb)),
            blender: Boolean(blender),
            ffmpeg: Boolean(ffmpeg)
        }),
        getPreviewUploadDirectory: () => previewUploadsDir,
        listJobs: () => Array.from(jobs.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view),
        getJob: (id) => jobs.has(id) ? view(jobs.get(id)) : null,
        createJob(snapshot, aspectRatio, settingsValue, scope) {
            if (!blender || !ffmpeg || !fs.existsSync(targetGlb))
                throw new Error('Blender、FFmpeg 或 UE4 目标模型不可用');
            if (!scope.projectId.trim() || !scope.canvasId.trim())
                throw new Error('缺少当前项目或画布 ID');
            const id = `director-video-${crypto.randomUUID()}`;
            const directory = path.join(jobsDir, id);
            fs.mkdirSync(directory, { recursive: true });
            const manifest = prepareManifest(snapshot, aspectRatio, settingsValue, directory);
            const manifestPath = path.join(directory, 'manifest.json');
            const scriptPath = path.join(directory, 'render_video.py');
            fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
            fs.writeFileSync(scriptPath, VIDEO_SCRIPT, 'utf8');
            const now = new Date().toISOString();
            const job = { id, status: 'queued', stage: '等待渲染', progress: 0, createdAt: now, updatedAt: now, directory, log: '', progressBuffer: '', scope };
            jobs.set(id, job);
            const append = (chunk) => { job.log = `${job.log}${chunk.toString('utf8')}`.slice(-64 * 1024); };
            const appendBlenderProgress = (chunk) => {
                append(chunk);
                job.progressBuffer = `${job.progressBuffer}${chunk.toString('utf8')}`.slice(-4096);
                const matches = Array.from(job.progressBuffer.matchAll(/MK_VIDEO_PROGRESS frame=(\d+) total=(\d+)/g));
                const latest = matches.at(-1);
                if (!latest)
                    return;
                const frame = Number(latest[1]);
                const total = Math.max(1, Number(latest[2]));
                update(job, { stage: `Blender 渲染 ${Math.min(frame + 1, total)} / ${total} 帧`, progress: Math.min(0.9, ((frame + 1) / total) * 0.9) });
            };
            const blenderProcess = spawnProcess(blender, ['--background', '--python-exit-code', '1', '--python', scriptPath, '--', '--manifest', manifestPath], { cwd: directory, windowsHide: true, stdio: 'pipe' });
            job.process = blenderProcess;
            update(job, { status: 'running', stage: 'Blender EEVEE Next 渲染', progress: 0 });
            blenderProcess.stdout.on('data', appendBlenderProgress);
            blenderProcess.stderr.on('data', appendBlenderProgress);
            job.timeout = setTimeout(() => {
                if (job.status !== 'running' && job.status !== 'encoding')
                    return;
                job.process?.kill();
                cleanupTemporaryFiles(directory);
                update(job, { status: 'timeout', message: '视频导出超时' });
            }, timeoutMs);
            blenderProcess.once('error', (error) => fail(job, error.message));
            blenderProcess.once('exit', (code) => {
                if (job.status !== 'running')
                    return;
                if (code !== 0)
                    return fail(job, job.log.trim().slice(-1000) || `Blender exited with code ${code}`);
                const outputPath = path.join(directory, 'director.mp4');
                const codec = manifest.codec === 'h265' ? 'libx265' : 'libx264';
                const quality = manifest.quality === 'high'
                    ? { crf: '18', preset: 'slow' }
                    : manifest.quality === 'compact'
                        ? { crf: '28', preset: 'fast' }
                        : { crf: '22', preset: 'medium' };
                const ffmpegProcess = spawnProcess(ffmpeg, ['-y', '-framerate', String(manifest.sourceFps), '-i', path.join(directory, 'frames', 'frame_%04d.png'), '-an', '-c:v', codec, '-preset', quality.preset, '-crf', quality.crf, '-r', String(manifest.outputFps), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath], { cwd: directory, windowsHide: true, stdio: 'pipe' });
                job.process = ffmpegProcess;
                job.progressBuffer = '';
                update(job, { status: 'encoding', stage: `FFmpeg ${manifest.codec.toUpperCase()} 编码`, progress: 0.9 });
                ffmpegProcess.stdout.on('data', (chunk) => {
                    append(chunk);
                    job.progressBuffer = `${job.progressBuffer}${chunk.toString('utf8')}`.slice(-4096);
                    const matches = Array.from(job.progressBuffer.matchAll(/frame=(\d+)/g));
                    const latest = matches.at(-1);
                    if (!latest)
                        return;
                    const frame = Number(latest[1]);
                    update(job, { stage: `FFmpeg 编码 ${Math.min(frame, manifest.durationFrames)} / ${manifest.durationFrames} 帧`, progress: Math.min(0.99, 0.9 + (frame / Math.max(1, manifest.durationFrames)) * 0.09) });
                });
                ffmpegProcess.stderr.on('data', append);
                ffmpegProcess.once('error', (error) => fail(job, error.message));
                ffmpegProcess.once('exit', (ffmpegCode) => {
                    if (job.status !== 'encoding')
                        return;
                    if (ffmpegCode !== 0 || !fs.existsSync(outputPath))
                        return fail(job, job.log.trim().slice(-1000) || `FFmpeg exited with code ${ffmpegCode}`);
                    persistVideo(job, outputPath, `Director-${id}.mp4`, '导演台视频');
                });
            });
            return view(job);
        },
        createPreviewJob(sourcePathValue, aspectRatio, settingsValue, durationFramesValue, scope) {
            if (!ffmpeg)
                throw new Error('FFmpeg 不可用');
            if (!scope.projectId.trim() || !scope.canvasId.trim())
                throw new Error('缺少当前项目或画布 ID');
            const uploadRoot = path.resolve(previewUploadsDir);
            const uploadedSource = path.resolve(sourcePathValue);
            if (!uploadedSource.startsWith(`${uploadRoot}${path.sep}`) || !fs.existsSync(uploadedSource)) {
                throw new Error('视口录制文件不在受控目录');
            }
            const settings = parseExportSettings(settingsValue);
            const durationFrames = Math.trunc(finite(Number(durationFramesValue), 'durationFrames', 1, 24 * 60 * 60));
            const ratio = typeof aspectRatio === 'string' && ASPECT_RATIOS[aspectRatio] ? aspectRatio : 'auto';
            const [width, height] = resolveResolution(ratio, settings.resolution);
            const id = `director-preview-${crypto.randomUUID()}`;
            const directory = path.join(jobsDir, id);
            const sourcePath = path.join(directory, 'preview-source.webm');
            const outputPath = path.join(directory, 'director-preview.mp4');
            fs.mkdirSync(directory, { recursive: true });
            fs.renameSync(uploadedSource, sourcePath);
            const now = new Date().toISOString();
            const job = {
                id,
                status: 'encoding',
                stage: 'FFmpeg 正在转换视口录制',
                progress: 0,
                createdAt: now,
                updatedAt: now,
                directory,
                log: '',
                progressBuffer: '',
                scope
            };
            jobs.set(id, job);
            const codec = settings.codec === 'h265' ? 'libx265' : 'libx264';
            const quality = settings.quality === 'high'
                ? { crf: '18', preset: 'medium' }
                : settings.quality === 'compact'
                    ? { crf: '28', preset: 'veryfast' }
                    : { crf: '22', preset: 'fast' };
            const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x0d0e10`;
            const ffmpegProcess = spawnProcess(ffmpeg, [
                '-y', '-i', sourcePath, '-an', '-vf', filter, '-c:v', codec,
                '-preset', quality.preset, '-crf', quality.crf, '-r', String(settings.frameRate),
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath
            ], { cwd: directory, windowsHide: true, stdio: 'pipe' });
            job.process = ffmpegProcess;
            const append = (chunk) => {
                const value = chunk.toString('utf8');
                job.log = `${job.log}${value}`.slice(-64 * 1024);
                job.progressBuffer = `${job.progressBuffer}${value}`.slice(-4096);
            };
            ffmpegProcess.stdout.on('data', (chunk) => {
                append(chunk);
                const matches = Array.from(job.progressBuffer.matchAll(/frame=(\d+)/g));
                const latest = matches.at(-1);
                if (!latest)
                    return;
                const frame = Number(latest[1]);
                update(job, {
                    stage: `FFmpeg 转换 ${Math.min(frame, durationFrames)} / ${durationFrames} 帧`,
                    progress: Math.min(0.98, frame / Math.max(1, durationFrames) * 0.98)
                });
            });
            ffmpegProcess.stderr.on('data', append);
            job.timeout = setTimeout(() => {
                if (job.status !== 'encoding')
                    return;
                job.process?.kill();
                cleanupTemporaryFiles(directory);
                update(job, { status: 'timeout', message: '视口视频转换超时' });
            }, timeoutMs);
            ffmpegProcess.once('error', (error) => fail(job, error.message));
            ffmpegProcess.once('exit', (code) => {
                if (job.status !== 'encoding')
                    return;
                if (code !== 0 || !fs.existsSync(outputPath))
                    return fail(job, job.log.trim().slice(-1000) || `FFmpeg exited with code ${code}`);
                persistVideo(job, outputPath, `Director-Preview-${id}.mp4`, '导演台白模预览');
            });
            return view(job);
        },
        cancelJob(id) {
            const job = jobs.get(id);
            if (!job)
                return null;
            if (job.status === 'queued' || job.status === 'running' || job.status === 'encoding') {
                job.process?.kill();
                if (job.timeout)
                    clearTimeout(job.timeout);
                cleanupTemporaryFiles(job.directory);
                update(job, { status: 'cancelled', message: '视频导出已取消' });
            }
            return view(job);
        },
        close() {
            jobs.forEach((job) => {
                if (job.status === 'running' || job.status === 'encoding')
                    job.process?.kill();
                if (job.timeout)
                    clearTimeout(job.timeout);
            });
        }
    };
};
