const fs = require('fs');
const path = require('path');
const { simplifyRoute } = require('./simplify');
const GpxParser = require('gpxparser');
const xml2js = require('xml2js');
const FitParser = require('fit-file-parser').default;
const zlib = require('zlib');
const util = require('util');

const gunzip = util.promisify(zlib.gunzip);

const ZWIFT_MANUFACTURER_ID = 260; // ユーザー要件: ZwiftのメーカーID

/**
 * 指定ディレクトリまたはファイルの配列を順次パースし、座標データを抽出する
 * @param {string | Array} inputSource - ディレクトリパスの文字列、または { originalname, buffer } の配列
 * @param {Object} options - { onProgress: (processed, total, filename) => void }
 */
async function parseRoutes(inputSource, options = {}) {
    const validExtensions = ['.gpx', '.tcx', '.fit', '.gz'];
    const routes = [];
    const targetFiles = [];

    if (typeof inputSource === 'string') {
        const files = fs.readdirSync(inputSource);
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            if (!validExtensions.includes(ext)) continue;

            let actualExt = ext;
            if (ext === '.gz') {
                const baseNameWithoutGz = path.basename(file, '.gz').toLowerCase();
                actualExt = path.extname(baseNameWithoutGz);
                if (!['.gpx', '.tcx', '.fit'].includes(actualExt)) continue;
            }
            targetFiles.push({ filename: file, filePath: path.join(inputSource, file), ext, actualExt });
        }
    } else if (Array.isArray(inputSource)) {
        for (const f of inputSource) {
            const filename = f.originalname || f.name;
            const ext = path.extname(filename).toLowerCase();
            if (!validExtensions.includes(ext)) continue;

            let actualExt = ext;
            if (ext === '.gz') {
                const baseNameWithoutGz = path.basename(filename, '.gz').toLowerCase();
                actualExt = path.extname(baseNameWithoutGz);
                if (!['.gpx', '.tcx', '.fit'].includes(actualExt)) continue;
            }
            targetFiles.push({ filename, buffer: f.buffer, ext, actualExt });
        }
    }

    const totalFiles = targetFiles.length;
    let processedCount = 0;

    for (const fileInfo of targetFiles) {
        const { filename, ext, actualExt } = fileInfo;
        const source = { buffer: fileInfo.buffer, filePath: fileInfo.filePath };

        try {
            let routeData = null;
            if (actualExt === '.gpx') {
                routeData = await parseGpx(source, ext === '.gz', filename);
            } else if (actualExt === '.tcx') {
                routeData = await parseTcx(source, ext === '.gz', filename);
            } else if (actualExt === '.fit') {
                routeData = await parseFit(source, ext === '.gz', filename);
            }

            if (routeData && routeData.points && routeData.points.length > 0) {
                // ポイント数を削減 (0.00005度 は約 5.5m の許容誤差)
                routeData.points = simplifyRoute(routeData.points, 0.00005);
                routes.push(routeData);
            }
        } catch (err) {
            if (!options.onProgress) {
                console.warn(`\n[Warning] Failed to parse ${filename}: ${err.message}. Skipping...`);
            }
        }

        processedCount++;
        if (options.onProgress) {
            options.onProgress(processedCount, totalFiles, filename);
        } else {
            // 現在の行をクリア(\x1b[2K)してキャリッジリターン(\r)で先頭に戻し、進捗を上書き表示
            process.stdout.write(`\r\x1b[2K${processedCount}/${totalFiles}`);
        }
    }

    if (!options.onProgress && totalFiles > 0) process.stdout.write('\n'); // 進行表示のあとに改行を追加

    return routes;
}

/**
 * ファイルの中身を取得する。gzの場合は解凍する。
 */
async function getFileContent(source, isGz, encoding = null) {
    let buffer;
    if (source.buffer) {
        buffer = source.buffer;
    } else {
        buffer = await fs.promises.readFile(source.filePath);
    }
    if (isGz) {
        const unzipped = await gunzip(buffer);
        return encoding ? unzipped.toString(encoding) : unzipped;
    }
    return encoding ? buffer.toString(encoding) : buffer;
}

/**
 * GPXファイルのパース
 */
async function parseGpx(source, isGz, filename) {
    const content = await getFileContent(source, isGz, 'utf8');
    const gpx = new GpxParser();
    gpx.parse(content);

    let points = [];
    if (gpx.tracks && gpx.tracks.length > 0) {
        gpx.tracks.forEach(track => {
            if (track.points) points.push(...track.points.map(p => [p.lon, p.lat]));
        });
    } else if (gpx.routes && gpx.routes.length > 0) {
        gpx.routes.forEach(route => {
            if (route.points) points.push(...route.points.map(p => [p.lon, p.lat]));
        });
    }
    return { filePath: filename, points };
}

/**
 * TCXファイルのパース
 */
async function parseTcx(source, isGz, filename) {
    const content = await getFileContent(source, isGz, 'utf8');
    const parser = new xml2js.Parser();
    const result = await parser.parseStringPromise(content);

    const points = [];
    try {
        const activities = result.TrainingCenterDatabase.Activities[0].Activity;
        for (const activity of activities) {
            if (!activity.Lap) continue;
            for (const lap of activity.Lap) {
                if (!lap.Track) continue;
                for (const track of lap.Track) {
                    if (!track.Trackpoint) continue;
                    for (const tp of track.Trackpoint) {
                        if (tp.Position && tp.Position[0]) {
                            const lat = parseFloat(tp.Position[0].LatitudeDegrees[0]);
                            const lon = parseFloat(tp.Position[0].LongitudeDegrees[0]);
                            if (!isNaN(lat) && !isNaN(lon)) {
                                points.push([lon, lat]);
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        throw new Error('Invalid TCX structure');
    }

    return { filePath: filename, points };
}

/**
 * FITファイルのパース (Zwift除外判定を含む)
 */
function parseFit(source, isGz, filename) {
    return new Promise(async (resolve, reject) => {
        try {
            const content = await getFileContent(source, isGz, null);

            const fitParser = new FitParser({
                force: true,
                speedUnit: 'km/h',
                lengthUnit: 'km',
                temperatureUnit: 'celsius',
                elapsedRecordField: true,
                mode: 'cascade',
            });

            fitParser.parse(content, (error, data) => {
                if (error) return reject(error);

                // Zwiftのアクティビティかどうかを判定
                let isZwift = false;
                const fileIds = data.file_ids || (data.file_id ? [data.file_id] : []);
                for (const fileId of fileIds) {
                    if (fileId.manufacturer === ZWIFT_MANUFACTURER_ID) {
                        isZwift = true;
                        break;
                    } else if (typeof fileId.manufacturer === 'string' && fileId.manufacturer.toLowerCase().includes('zwift')) {
                        isZwift = true;
                        break;
                    }
                }

                const fileCreators = data.file_creators || (data.file_creator ? [data.file_creator] : []);
                for (const creator of fileCreators) {
                    if (creator.software_part_number === ZWIFT_MANUFACTURER_ID) {
                        isZwift = true;
                        break;
                    }
                }

                if (isZwift) {
                    // console.warnはCLI実行時のみ出したいので、filenameだけ考慮して除外
                    return resolve(null);
                }

                const points = [];
                // cascadeモードでの座標取得
                if (data.activity && data.activity.sessions) {
                    data.activity.sessions.forEach(session => {
                        if (session.laps) {
                            session.laps.forEach(lap => {
                                if (lap.records) {
                                    lap.records.forEach(record => {
                                        if (record.position_lat && record.position_long) {
                                            points.push([record.position_long, record.position_lat]);
                                        }
                                    });
                                }
                            });
                        }
                    });
                }

                // フォールバック: 直下に records がある場合
                if (points.length === 0 && data.records && data.records.length > 0) {
                    data.records.forEach(record => {
                        if (record.position_lat && record.position_long) {
                            points.push([record.position_long, record.position_lat]);
                        }
                    });
                }

                resolve({ filePath: filename, points });
            });
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { parseRoutes };
