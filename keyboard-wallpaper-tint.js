import { applyWindowBackdrop } from '/scripts/window-backdrop.js';
import { subscribeWindowSnapshot } from '/scripts/util/window-layout.js';

const wallpaperIds = ['bg1', 'bg2', 'bg_custom'];
const wallpaperSelector = '#bg1, #bg2, #bg_custom, #themes';
const controllerKey = '__ttKeyboardWallpaperTint';
const styleId = 'mfi-keyboard-wallpaper-tint';
const updateDelay = 120;
const wallpaperGrace = 1000;

function readWallpaper(root) {
    for (const layer of [...wallpaperIds.map(id => document.getElementById(id)), document.body, root]) {
        if (!layer) continue;
        const style = getComputedStyle(layer);
        if (style.display === 'none' || style.visibility !== 'visible' || style.opacity === '0') continue;
        const match = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^()]+))\s*\)/i.exec(style.backgroundImage);
        if (!match) continue;
        const value = (match[1] ?? match[2] ?? match[3]).trim().replace(/\\(["'\\])/g, '$1');
        let url;
        try {
            url = new URL(value, document.baseURI);
        } catch {
            continue;
        }
        if (url.protocol !== 'blob:' && url.protocol !== 'data:' &&
            (!/^https?:$/.test(url.protocol) || url.origin !== location.origin)) continue;

        const nativeWindow = layer.id === 'bg1' && layer.classList.contains('tt-window-background');
        const nativeWidth = nativeWindow && Number.parseFloat(layer.style.getPropertyValue('--tt-window-width'));
        const nativeHeight = nativeWindow && Number.parseFloat(layer.style.getPropertyValue('--tt-window-height'));
        return {
            url: url.href,
            size: style.backgroundSize.split(',')[0].trim(),
            position: style.backgroundPosition.split(',')[0].trim(),
            width: nativeWidth || layer.offsetWidth || window.innerWidth,
            height: nativeHeight || layer.offsetHeight || window.innerHeight,
        };
    }
    return null;
}

function cssLength(value, reference) {
    if (value?.endsWith('%')) return reference * Number.parseFloat(value) / 100;
    if (value === '0' || value?.endsWith('px')) return Number.parseFloat(value);
    return NaN;
}

function imageSize(scene, image) {
    const { naturalWidth, naturalHeight } = image;
    const [x, y] = scene.size.split(/\s+/);
    if (x === 'cover' || x === 'contain') {
        const scale = (x === 'cover' ? Math.max : Math.min)(scene.width / naturalWidth, scene.height / naturalHeight);
        return [naturalWidth * scale, naturalHeight * scale];
    }
    const width = cssLength(x, scene.width);
    const height = cssLength(y, scene.height);
    if (width > 0) return [width, height > 0 ? height : width * naturalHeight / naturalWidth];
    if (height > 0) return [height * naturalWidth / naturalHeight, height];
    return [naturalWidth, naturalHeight];
}

function imageOffset(value, space) {
    if (value === 'left' || value === 'top') return 0;
    if (value === 'right' || value === 'bottom') return space;
    const length = cssLength(value, space);
    return Number.isFinite(length) ? length : space / 2;
}

function averageColor(pixels) {
    let weight = 0;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3];
        weight += alpha;
        red += pixels[i] * alpha;
        green += pixels[i + 1] * alpha;
        blue += pixels[i + 2] * alpha;
    }
    return weight ? [red, green, blue].map(channel => Math.round(channel / weight)) : null;
}

function sampleColor(scene, image) {
    if (!image?.naturalWidth || !image.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 64 / Math.max(scene.width, scene.height, 1));
    canvas.width = Math.max(1, Math.round(scene.width * scale));
    canvas.height = Math.max(1, Math.round(scene.height * scale));
    const paint = canvas.getContext('2d', { willReadFrequently: true });
    if (!paint) return null;
    const [width, height] = imageSize(scene, image);
    let [x = '50%', y = '50%'] = scene.position.split(/\s+/).filter(Boolean);
    if (x === 'top' || x === 'bottom') [x, y] = [y, x];
    try {
        paint.drawImage(image, imageOffset(x, scene.width - width) * scale,
            imageOffset(y, scene.height - height) * scale, width * scale, height * scale);
        const top = Math.floor(canvas.height * 0.55);
        return averageColor(paint.getImageData(0, top, canvas.width, canvas.height - top).data) ??
            averageColor(paint.getImageData(0, 0, canvas.width, canvas.height).data);
    } catch {
        // A redirected image may be visible even when the browser cannot read its pixels.
        return null;
    }
}

export function startKeyboardWallpaperTint() {
    // The standalone v1.1 script already owns this window when enabled first.
    if (typeof window[controllerKey]?.dispose === 'function') return;
    const root = document.documentElement;
    const paint = document.createElement('style');
    paint.id = styleId;
    const inlineColors = new Map();
    const watched = new WeakSet();
    let imageCache;
    let sceneCache;
    let updateTimer;
    let missingTimer;
    let missingExpired = false;
    let generation = 0;
    let destroyed = false;

    function externalBackdropActive() {
        if (root.classList.contains('tt-oled-background')) return true;
        const moonSync = root.classList.contains('moon-wallpaper-sync-on') ||
            (window.__moonPaperSyncV13 && root.style.getPropertyValue('--paper-moon-window-base').trim());
        if (!moonSync) return false;
        const activeTheme = document.getElementById('custom-style')?.textContent.trim();
        return activeTheme
            ? /--moon-glass-wash\s*:/.test(activeTheme) && /--book-epigraph\s*:/.test(activeTheme)
            : !!document.getElementById('themes')?.value?.includes('纸月');
    }

    function releasePaint(publish = true) {
        const wasPainted = paint.isConnected || inlineColors.size > 0;
        paint.remove();
        for (const [element, { original, applied }] of inlineColors) {
            const style = element.style;
            if (style.getPropertyPriority('background-color') === 'important' &&
                style.getPropertyValue('background-color') === applied) {
                style.setProperty('background-color', original, 'important');
            }
        }
        inlineColors.clear();
        if (publish && wasPainted && !externalBackdropActive()) applyWindowBackdrop();
        return wasPainted;
    }

    function applyPaint(color) {
        const rgb = 'rgb(' + color.join(', ') + ')';
        const html = 'html:root:root:not(.tt-oled-background)';
        const rule = html + ', ' + html + ' body { background-color: ' + rgb + ' !important; }\n' +
            html + ' body { isolation: isolate; }';
        let changed = !paint.isConnected || paint.textContent !== rule;
        if (paint.textContent !== rule) paint.textContent = rule;
        if (!paint.isConnected) document.head.append(paint);
        // Inline !important outranks our stylesheet. Record only what we replace.
        for (const element of [root, document.body]) {
            const style = element.style;
            if (style.getPropertyPriority('background-color') !== 'important') {
                inlineColors.delete(element);
                continue;
            }
            const value = style.getPropertyValue('background-color');
            if (value === rgb) continue;
            const prior = inlineColors.get(element);
            style.setProperty('background-color', rgb, 'important');
            inlineColors.set(element, {
                original: prior?.applied === value ? prior.original : value,
                applied: style.getPropertyValue('background-color'),
            });
            changed = true;
        }
        if (changed) applyWindowBackdrop();
    }

    function loadImage(url) {
        if (imageCache?.url === url) return imageCache.promise;
        const image = new Image();
        image.src = url;
        const promise = image.decode().then(() => image, () => {
            if (imageCache?.promise === promise) imageCache = undefined;
            return null;
        });
        imageCache = { url, promise };
        return promise;
    }

    function clearMissingTimer() {
        window.clearTimeout(missingTimer);
        missingTimer = undefined;
        missingExpired = false;
    }

    function missingWallpaper() {
        if (!paint.isConnected && !inlineColors.size) return;
        if (missingExpired) {
            clearMissingTimer();
            releasePaint();
            return;
        }
        if (missingTimer !== undefined) return;
        missingTimer = window.setTimeout(() => {
            missingTimer = undefined;
            missingExpired = true;
            schedule();
        }, wallpaperGrace);
    }

    async function sync(ticket) {
        if (externalBackdropActive()) {
            clearMissingTimer();
            releasePaint();
            return;
        }
        const scene = readWallpaper(root);
        if (!scene) {
            missingWallpaper();
            return;
        }
        const key = JSON.stringify([scene.url, scene.size, scene.position, scene.width, scene.height]);
        if (sceneCache?.key !== key) {
            const image = await loadImage(scene.url);
            if (destroyed || ticket !== generation || externalBackdropActive()) return;
            const color = sampleColor(scene, image);
            if (!color) {
                missingWallpaper();
                return;
            }
            sceneCache = { key, color };
        }
        clearMissingTimer();
        applyPaint(sceneCache.color);
    }

    function schedule() {
        const ticket = ++generation;
        window.clearTimeout(updateTimer);
        updateTimer = window.setTimeout(() => {
            sync(ticket).catch(error => console.warn('[MobileFocus] 无法读取壁纸底色', error));
        }, updateDelay);
    }

    function watchLayers() {
        for (const layer of [document.body, ...wallpaperIds.map(id => document.getElementById(id))]) {
            if (!layer || watched.has(layer)) continue;
            observer.observe(layer, {
                attributes: true, attributeFilter: ['style', 'class', 'hidden'], childList: layer === document.body,
            });
            watched.add(layer);
        }
    }

    function isThemeStyle(node) {
        return node !== paint && (node?.id === 'custom-style' || node?.matches?.('link[rel~="stylesheet"]') ||
            (node?.localName === 'style' && /#(?:bg1|bg2|bg_custom)\b/.test(node.textContent)));
    }

    function onMutation(records) {
        const changed = records.some(record => {
            if (record.target === paint || record.target.parentElement === paint) return false;
            if (record.type === 'attributes') return true;
            if (isThemeStyle(record.target) || isThemeStyle(record.target.parentElement)) return true;
            if ([...record.removedNodes].includes(paint)) return true;
            return [...record.addedNodes, ...record.removedNodes].some(node =>
                node?.localName === 'body' || node?.matches?.(wallpaperSelector) ||
                node?.querySelector?.(wallpaperSelector) || isThemeStyle(node));
        });
        if (!changed) return;
        watchLayers();
        if (externalBackdropActive()) {
            clearMissingTimer();
            releasePaint();
        }
        schedule();
    }

    const observer = new MutationObserver(onMutation);
    observer.observe(root, { attributes: true, attributeFilter: ['style', 'class'], childList: true });
    observer.observe(document.head, { childList: true, characterData: true, subtree: true });
    watchLayers();
    document.addEventListener('change', onThemeChange);
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    const unsubscribe = subscribeWindowSnapshot(schedule);
    schedule();

    function onThemeChange(event) {
        if (event.target?.id === 'themes') schedule();
    }

    function dispose({ handoff = false } = {}) {
        if (destroyed) return false;
        destroyed = true;
        window.clearTimeout(updateTimer);
        clearMissingTimer();
        observer.disconnect();
        unsubscribe();
        document.removeEventListener('change', onThemeChange);
        window.removeEventListener('resize', schedule);
        window.visualViewport?.removeEventListener('resize', schedule);
        const owned = releasePaint(!handoff);
        imageCache = sceneCache = undefined;
        if (window[controllerKey] === controller) delete window[controllerKey];
        return owned;
    }

    const controller = { dispose };
    window[controllerKey] = controller;
    return dispose;
}
