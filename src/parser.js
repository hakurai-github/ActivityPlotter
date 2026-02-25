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
 * 指定ディレクトリのルートファイルを順次パースし、座標データを抽出する
 */
async function parseRoutes(inputDir) {
    const files = fs.readdirSync(inputDir);
    const validExtensions = ['.gpx', '.tcx', '.fit', '.gz'];
    const routes = [];

    // パース対象となるファイルを事前抽出して合計数を取得
    const targetFiles = [];
    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (!validExtensions.includes(ext)) continue;

        let actualExt = ext;
        if (ext === '.gz') {
            const baseNameWithoutGz = path.basename(file, '.gz').toLowerCase();
            actualExt = path.extname(baseNameWithoutGz);
            if (!['.gpx', '.tcx', '.fit'].includes(actualExt)) {
                continue; // サポート対象外のgz
            }
        }
        targetFiles.push({ file, ext, actualExt });
    }

    const totalFiles = targetFiles.length;
    let processedCount = 0;

    for (const { file, ext, actualExt } of targetFiles) {
        const filePath = path.join(inputDir, file);

        try {
            let routeData = null;
            if (actualExt === '.gpx') {
                routeData = await parseGpx(filePath, ext === '.gz');
            } else if (actualExt === '.tcx') {
                routeData = await parseTcx(filePath, ext === '.gz');
            } else if (actualExt === '.fit') {
                routeData = await parseFit(filePath, ext === '.gz');
            }

            if (routeData && routeData.points && routeData.points.length > 0) {
                // ポイント数を削減 (0.00005度 は約 5.5m の許容誤差)
                routeData.points = simplifyRoute(routeData.points, 0.00005);
                routes.push(routeData);
            }
        } catch (err) {
            console.warn(`\n[Warning] Failed to parse ${file}: ${err.message}. Skipping...`);
        }

        processedCount++;
        // 現在の行をクリア(\x1b[2K)してキャリッジリターン(\r)で先頭に戻し、進捗を上書き表示
        process.stdout.write(`\r\x1b[2K${processedCount}/${totalFiles}`);
    }

    if (totalFiles > 0) process.stdout.write('\n'); // 進行表示のあとに改行を追加

    return routes;
}

/**
 * ファイルの中身を取得する。gzの場合は解凍する。
 */
async function getFileContent(filePath, isGz, encoding = null) {
    const buffer = await fs.promises.readFile(filePath);
    if (isGz) {
        const unzipped = await gunzip(buffer);
        return encoding ? unzipped.toString(encoding) : unzipped;
    }
    return encoding ? buffer.toString(encoding) : buffer;
}

/**
 * GPXファイルのパース
 */
async function parseGpx(filePath, isGz) {
    const content = await getFileContent(filePath, isGz, 'utf8');
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
    return { filePath, points };
}

/**
 * TCXファイルのパース
 */
async function parseTcx(filePath, isGz) {
    const content = await getFileContent(filePath, isGz, 'utf8');
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

    return { filePath, points };
}

/**
 * FITファイルのパース (Zwift除外判定を含む)
 */
function parseFit(filePath, isGz) {
    return new Promise(async (resolve, reject) => {
        try {
            const content = await getFileContent(filePath, isGz, null);

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
                    console.warn(`[Skip] Zwift virtual activity detected in ${path.basename(filePath)}`);
                    return resolve(null); // 除外のためnullを返す
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

                resolve({ filePath, points });
            });
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { parseRoutes };
