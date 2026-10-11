<?php
declare(strict_types=1);

date_default_timezone_set('Asia/Tokyo');

$projectRoot = dirname(__DIR__);
$storageRoot = __DIR__ . DIRECTORY_SEPARATOR . 'storage';
$startedAt = microtime(true);
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

function hankyu_json_response(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function hankyu_write_log(string $storageRoot, array $event): void
{
    $directory = $storageRoot . DIRECTORY_SEPARATOR . 'logs';
    if (!is_dir($directory) && !@mkdir($directory, 0770, true) && !is_dir($directory)) {
        return;
    }

    $event['logged_at'] = date(DATE_ATOM);
    $line = json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    if (is_string($line)) {
        @file_put_contents($directory . DIRECTORY_SEPARATOR . date('Y-m-d') . '.jsonl', $line . PHP_EOL, FILE_APPEND | LOCK_EX);
    }
}

function hankyu_finish_error(string $storageRoot, float $startedAt, string $path, int $status, string $message, array $details = []): never
{
    hankyu_write_log($storageRoot, array_merge([
        'method' => strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'),
        'path' => $path,
        'status' => $status,
        'elapsed_ms' => (int) round((microtime(true) - $startedAt) * 1000),
    ], $details));

    hankyu_json_response(['error' => $message], $status);
}

function hankyu_auth_token(string $projectRoot): ?string
{
    $environmentToken = trim((string) getenv('HANKYU_APP_AUTH_TOKEN'));
    if ($environmentToken !== '') {
        return $environmentToken;
    }

    $authConfigFile = $projectRoot . DIRECTORY_SEPARATOR . 'config' . DIRECTORY_SEPARATOR . 'app-auth.json';
    $rawAuthConfig = @file_get_contents($authConfigFile);
    $authConfig = is_string($rawAuthConfig) ? json_decode($rawAuthConfig, true) : null;
    $configuredToken = is_array($authConfig) ? ($authConfig['app_auth_token'] ?? null) : null;
    if (is_string($configuredToken) && trim($configuredToken) !== '') {
        return trim($configuredToken);
    }

    $buildConfig = $projectRoot . DIRECTORY_SEPARATOR . 'analysis' . DIRECTORY_SEPARATOR . 'decompiled'
        . DIRECTORY_SEPARATOR . 'sources' . DIRECTORY_SEPARATOR . 'jp' . DIRECTORY_SEPARATOR . 'co'
        . DIRECTORY_SEPARATOR . 'hankyu' . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'BuildConfig.java';

    if (!is_file($buildConfig) || !is_readable($buildConfig)) {
        return null;
    }

    $source = @file_get_contents($buildConfig);
    if (!is_string($source) || !preg_match('/APP_AUTH_TOKEN\s*=\s*"([^"]+)"/', $source, $matches)) {
        return null;
    }

    return $matches[1];
}

function hankyu_save_snapshot(string $storageRoot, int $lineId, string $rawJson): ?string
{
    $dayDirectory = $storageRoot . DIRECTORY_SEPARATOR . 'hankyu-json' . DIRECTORY_SEPARATOR . date('Y-m-d');
    if (!is_dir($dayDirectory) && !@mkdir($dayDirectory, 0770, true) && !is_dir($dayDirectory)) {
        return null;
    }

    try {
        $suffix = bin2hex(random_bytes(4));
    } catch (Throwable) {
        $suffix = str_replace('.', '', uniqid('', true));
    }

    $filename = date('Ymd_His') . '_line-' . str_pad((string) $lineId, 2, '0', STR_PAD_LEFT) . '_' . $suffix . '.json';
    $target = $dayDirectory . DIRECTORY_SEPARATOR . $filename;
    $temporary = $target . '.tmp';

    if (@file_put_contents($temporary, $rawJson, LOCK_EX) === false) {
        return null;
    }
    if (!@rename($temporary, $target)) {
        @unlink($temporary);
        return null;
    }

    return 'hankyu-json/' . date('Y-m-d') . '/' . $filename;
}

if (!is_string($path)) {
    hankyu_finish_error($storageRoot, $startedAt, '', 400, '不正なリクエストです。');
}
if ($method !== 'GET') {
    header('Allow: GET');
    hankyu_finish_error($storageRoot, $startedAt, $path, 405, 'GETでアクセスしてください。');
}

if ($path === '/api/lines') {
    $linesFile = $projectRoot . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'lines.json';
    $rawLines = @file_get_contents($linesFile);
    $lines = is_string($rawLines) ? json_decode($rawLines, true) : null;
    if (!is_array($lines)) {
        hankyu_finish_error($storageRoot, $startedAt, $path, 500, '路線データを読み込めません。', ['failure_kind' => 'lines_file']);
    }

    hankyu_write_log($storageRoot, [
        'method' => $method,
        'path' => $path,
        'status' => 200,
        'elapsed_ms' => (int) round((microtime(true) - $startedAt) * 1000),
        'line_count' => count($lines),
    ]);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    header('X-Content-Type-Options: nosniff');
    echo $rawLines;
    exit;
}

if ($path !== '/api/positions') {
    hankyu_finish_error($storageRoot, $startedAt, $path, 404, 'APIが見つかりません。');
}

$lineValue = $_GET['line_id'] ?? '';
if (!is_scalar($lineValue) || !preg_match('/^\d{1,3}$/', (string) $lineValue)) {
    hankyu_finish_error($storageRoot, $startedAt, $path, 400, '路線IDを指定してください。');
}
$lineId = (int) $lineValue;

$linesFile = $projectRoot . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'lines.json';
$rawLines = @file_get_contents($linesFile);
$lines = is_string($rawLines) ? json_decode($rawLines, true) : null;
$validLineIds = is_array($lines) ? array_map(static fn ($line) => (int) ($line['id'] ?? 0), $lines) : [];
if (!in_array($lineId, $validLineIds, true)) {
    hankyu_finish_error($storageRoot, $startedAt, $path, 400, '指定された路線IDはありません。', ['line_id' => $lineId]);
}

if (!function_exists('curl_init')) {
    hankyu_finish_error($storageRoot, $startedAt, $path, 500, 'PHPのcURL拡張が有効ではありません。', ['line_id' => $lineId, 'failure_kind' => 'curl_missing']);
}

$token = hankyu_auth_token($projectRoot);
if ($token === null || $token === '') {
    hankyu_finish_error($storageRoot, $startedAt, $path, 503, 'API接続設定がありません。', ['line_id' => $lineId, 'failure_kind' => 'token_missing']);
}

$url = 'https://cdn.hankyu-app.com/v1/train/positions/?train_position_line_id=' . $lineId;
$curl = curl_init($url);
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 8,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_HTTPHEADER => [
        'x-auth-token: ' . $token,
        'Accept: application/json',
        'User-Agent: HankyuWeb/1.0 PHP/' . PHP_VERSION,
    ],
]);

$rawResponse = curl_exec($curl);
$upstreamStatus = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
$curlFailed = $rawResponse === false;
curl_close($curl);
unset($token);

if ($curlFailed) {
    hankyu_finish_error($storageRoot, $startedAt, $path, 502, '阪急APIに接続できません。', [
        'line_id' => $lineId,
        'upstream_status' => $upstreamStatus,
        'failure_kind' => 'upstream_connection',
    ]);
}

if ($upstreamStatus < 200 || $upstreamStatus >= 300) {
    hankyu_finish_error($storageRoot, $startedAt, $path, 502, '阪急APIからエラー応答が返りました。', [
        'line_id' => $lineId,
        'upstream_status' => $upstreamStatus,
        'failure_kind' => 'upstream_http',
    ]);
}

$payload = json_decode($rawResponse, true);
if (!is_array($payload) || !isset($payload['positions']) || !is_array($payload['positions'])) {
    hankyu_finish_error($storageRoot, $startedAt, $path, 502, '阪急APIの応答形式を読み取れません。', [
        'line_id' => $lineId,
        'upstream_status' => $upstreamStatus,
        'failure_kind' => 'upstream_json',
    ]);
}

$snapshotPath = hankyu_save_snapshot($storageRoot, $lineId, $rawResponse);
if ($snapshotPath === null) {
    hankyu_finish_error($storageRoot, $startedAt, $path, 500, '阪急JSONをサーバーに保存できません。', [
        'line_id' => $lineId,
        'upstream_status' => $upstreamStatus,
        'failure_kind' => 'storage_write',
    ]);
}

hankyu_write_log($storageRoot, [
    'method' => $method,
    'path' => $path,
    'status' => 200,
    'elapsed_ms' => (int) round((microtime(true) - $startedAt) * 1000),
    'line_id' => $lineId,
    'upstream_status' => $upstreamStatus,
    'state' => is_string($payload['state'] ?? null) ? $payload['state'] : null,
    'positions_count' => count($payload['positions']),
    'response_bytes' => strlen($rawResponse),
    'snapshot' => $snapshotPath,
]);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
header('X-Content-Type-Options: nosniff');
echo $rawResponse;
