const StaticMaps = require('staticmaps');

// 日本全体の固定バウンディングボックス [lon1, lat1, lon2, lat2]
const JAPAN_BBOX = [122.93, 24.05, 153.99, 45.55];

/**
 * ルートデータの配列を受け取り、地図画像を生成して保存する
 * @param {Array} routes - [{ filePath, points: [[lon, lat], ...] }, ...]
 * @param {Object} options - { width, height, bbox: boolean, output: string }
 */
async function drawMap(routes, options) {
    const width = parseInt(options.width, 10) || 1920;
    const height = parseInt(options.height, 10) || 1080;

    let tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'; // default: osm
    if (options.style === 'dark') {
        tileUrl = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    } else if (options.style === 'light') {
        tileUrl = 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
    }

    const mapOptions = {
        width,
        height,
        tileUrl
    };

    const map = new StaticMaps(mapOptions);

    for (const route of routes) {
        if (!route.points || route.points.length === 0) continue;

        let segments = [];
        if (options.bounds || options.japan) {
            const targetBbox = options.bounds || JAPAN_BBOX;
            let currentSegment = [];
            for (const pt of route.points) {
                const inBounds = pt[0] >= targetBbox[0] && pt[0] <= targetBbox[2] && pt[1] >= targetBbox[1] && pt[1] <= targetBbox[3];
                if (inBounds) {
                    currentSegment.push(pt);
                } else {
                    if (currentSegment.length > 0) {
                        segments.push(currentSegment);
                        currentSegment = [];
                    }
                }
            }
            if (currentSegment.length > 0) {
                segments.push(currentSegment);
            }
        } else {
            segments = [route.points];
        }

        // staticmapsライブラリ内部でのコールスタックオーバーフローを避けるため、
        // 座標配列が長すぎる場合は分割（チャンク化）して追加する
        const CHUNK_SIZE = 10000;
        for (const segment of segments) {
            for (let i = 0; i < segment.length; i += CHUNK_SIZE - 1) {
                const chunk = segment.slice(i, i + CHUNK_SIZE);
                // チャンクが1点だけの場合は線にならないため描画しない
                if (chunk.length < 2 && segment.length > 1) continue;

                const line = {
                    coords: chunk,
                    color: `rgba(${options.color}, ${options.alpha})`,
                    width: 2
                };

                map.addLine(line);
            }
        }
    }

    // 描画範囲の判定（優先順位: bounds > japan > bbox > 全世界）
    if (options.bounds) {
        console.log(`Rendering map for specific boundaries: ${options.bounds.join(',')}...`);
        await map.render(options.bounds);
    } else if (options.japan) {
        console.log('Rendering map for Japan area...');
        await map.render(JAPAN_BBOX);
    } else if (options.bbox) {
        console.log('Rendering map with auto-calculated Bounding Box...');
        // 引数なしの render() は追加された線すべてを含むように自動調整される
        await map.render();
    } else {
        console.log('Rendering whole world map... (bbox flag is false)');
        // center: [lon, lat], zoom: 2 で大まかな世界全体を描画
        await map.render([0, 0], 2);
    }

    // 描画したマップをファイルに保存 (オプション指定時)
    if (options.output) {
        await map.image.save(options.output);
    }

    // Web向けに画像Bufferを返す
    return await map.image.buffer('image/png');
}

module.exports = { drawMap };
