<?php
declare(strict_types=1);

$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (is_string($requestPath) && str_starts_with($requestPath, '/api/')) {
    require __DIR__ . '/api.php';
    return true;
}

return false;
