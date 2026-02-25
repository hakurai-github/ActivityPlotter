/**
 * Douglas-Peucker algorithm for reducing the number of points in a curve.
 * Adapted for [lon, lat] coordinate arrays.
 */

// 2点間の距離の2乗を計算
function getSqDist(p1, p2) {
    const dx = p1[0] - p2[0];
    const dy = p1[1] - p2[1];
    return dx * dx + dy * dy;
}

// 点pと線分(p1, p2)間の距離の2乗を計算
function getSqSegDist(p, p1, p2) {
    let x = p1[0];
    let y = p1[1];
    let dx = p2[0] - x;
    let dy = p2[1] - y;

    if (dx !== 0 || dy !== 0) {
        const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);

        if (t > 1) {
            x = p2[0];
            y = p2[1];
        } else if (t > 0) {
            x += dx * t;
            y += dy * t;
        }
    }

    dx = p[0] - x;
    dy = p[1] - y;

    return dx * dx + dy * dy;
}

// 再帰的なDouglas-Peuckerステップ
function simplifyDPStep(points, first, last, sqTolerance, simplified) {
    let maxSqDist = sqTolerance;
    let index;

    for (let i = first + 1; i < last; i++) {
        const sqDist = getSqSegDist(points[i], points[first], points[last]);

        if (sqDist > maxSqDist) {
            index = i;
            maxSqDist = sqDist;
        }
    }

    if (maxSqDist > sqTolerance) {
        if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified);
        simplified.push(points[index]);
        if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified);
    }
}

// Douglas-Peuckerアルゴリズムのメイン
function simplifyDouglasPeucker(points, sqTolerance) {
    const last = points.length - 1;
    const simplified = [points[0]];
    simplifyDPStep(points, 0, last, sqTolerance, simplified);
    simplified.push(points[last]);
    return simplified;
}

// 距離ベースのプレ間引き（高速化のため）
function simplifyRadialDist(points, sqTolerance) {
    let prevPoint = points[0];
    const newPoints = [prevPoint];
    let point;

    for (let i = 1, len = points.length; i < len; i++) {
        point = points[i];

        if (getSqDist(point, prevPoint) > sqTolerance) {
            newPoints.push(point);
            prevPoint = point;
        }
    }

    if (prevPoint !== point) newPoints.push(point);
    return newPoints;
}

/**
 * ポリラインのポイント数を間引く
 *
 * @param {Array} points - [lon, lat]の配列
 * @param {Number} tolerance - 許容する誤差（度）。例: 0.00005 は約5.5mの誤差を許容
 * @returns {Array} - 間引かれた [lon, lat] の配列
 */
function simplifyRoute(points, tolerance = 0.00005) {
    if (points.length <= 2) return points;

    const sqTolerance = tolerance * tolerance;
    // まず距離のプレフィルタをかける
    let simplified = simplifyRadialDist(points, sqTolerance);
    // そして高精度なDouglas-Peucker法を適用
    simplified = simplifyDouglasPeucker(simplified, sqTolerance);

    return simplified;
}

module.exports = { simplifyRoute };
