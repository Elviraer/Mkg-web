const DOUBAO_IMAGE_RATIOS = ['3:4', '4:3', '1:1', '9:16', '16:9', '2:3'];
const DOUBAO_VIDEO_RATIOS = ['9:16', '16:9', '4:3', '3:4', '1:1', '21:9'];
const DOUBAO_IMAGE_MODELS = ['Seedream 5.0 Lite', 'Seedream 4.5', 'Seedream 4.0'];
const DOUBAO_VIDEO_MODELS = ['seedance_v2.0', 'seedance_v2.0_mini', 'seedance_v2.0_std', 'seedance_v2.5'];
const DOLA_IMAGE_RATIOS = ['3:4', '4:3', '1:1', '9:16', '16:9', '2:3'];
const DOLA_VIDEO_RATIOS = ['9:16', '16:9', '4:3', '3:4', '1:1', '21:9'];
const DOLA_IMAGE_MODELS = ['Seedream 5.0 Pro', 'Seedream 5.0 Lite', 'Seedream 4.5', 'Seedream 4.0'];
const DOLA_VIDEO_MODELS = ['seedance_v2.0', 'seedance_v2.5'];
const DOLA_VIDEO_DURATIONS_V20 = [5, 10, 15];
const DOLA_VIDEO_DURATIONS_V25 = [5, 10, 15, 20, 25, 30];
const XYQ_IMAGE_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];
const XYQ_VIDEO_RATIOS = ['16:9', '9:16', '4:3', '3:4'];
const XYQ_IMAGE_RESOLUTIONS = ['1K', '2K', '4K', '8K'];
const normalizeChoice = (value, supportedValues, fallback) => (value && supportedValues.includes(value)
    ? value
    : fallback);
const normalizeInteger = (value, fallback) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : fallback;
};
export const normalizeDoubaoImageRatio = (ratio) => (normalizeChoice(ratio, DOUBAO_IMAGE_RATIOS, '16:9'));
export const normalizeDoubaoVideoRatio = (ratio) => (normalizeChoice(ratio, DOUBAO_VIDEO_RATIOS, '16:9'));
export const normalizeDoubaoImageModel = (model) => (normalizeChoice(model, DOUBAO_IMAGE_MODELS, 'Seedream 5.0 Lite'));
export const normalizeDoubaoVideoModel = (model) => (normalizeChoice(model, DOUBAO_VIDEO_MODELS, 'seedance_v2.0'));
export const normalizeDoubaoVideoDuration = (duration, model) => {
    const requestedDuration = normalizeInteger(duration, 10);
    const maxDuration = normalizeDoubaoVideoModel(model) === 'seedance_v2.5' ? 30 : 15;
    return Math.min(maxDuration, Math.max(4, requestedDuration));
};
export const normalizeDolaImageRatio = (ratio) => normalizeChoice(ratio, DOLA_IMAGE_RATIOS, '16:9');
export const normalizeDolaVideoRatio = (ratio) => normalizeChoice(ratio, DOLA_VIDEO_RATIOS, '16:9');
export const normalizeDolaImageModel = (model) => normalizeChoice(model, DOLA_IMAGE_MODELS, 'Seedream 5.0 Lite');
export const normalizeDolaVideoModel = (model) => normalizeChoice(model, DOLA_VIDEO_MODELS, 'seedance_v2.0');
export const normalizeDolaVideoDuration = (duration, model) => {
    const requestedDuration = normalizeInteger(duration, 10);
    const options = model === 'seedance_v2.5' ? DOLA_VIDEO_DURATIONS_V25 : DOLA_VIDEO_DURATIONS_V20;
    return options.reduce((closest, current) => {
        const closestDistance = Math.abs(requestedDuration - closest);
        const currentDistance = Math.abs(requestedDuration - current);
        return currentDistance < closestDistance || (currentDistance === closestDistance && current > closest)
            ? current
            : closest;
    }, options[0]);
};
export const normalizeXyqImageRatio = (ratio) => (normalizeChoice(ratio, XYQ_IMAGE_RATIOS, '16:9'));
export const normalizeXyqVideoRatio = (ratio) => (normalizeChoice(ratio, XYQ_VIDEO_RATIOS, '16:9'));
export const normalizeXyqImageResolution = (resolution) => (normalizeChoice(resolution, XYQ_IMAGE_RESOLUTIONS, '2K'));
export const normalizeXyqVideoDuration = (duration) => {
    const integerDuration = normalizeInteger(duration, 5);
    return Math.min(Math.max(integerDuration, 4), 15);
};
