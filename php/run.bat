@echo off
setlocal
set "PHP_EXE=C:\xampp\php\php.exe"
if not exist "%PHP_EXE%" set "PHP_EXE=php"
echo Hankyu PHP web: http://127.0.0.1:18732/
echo Stop the server with Ctrl+C.
"%PHP_EXE%" -S 127.0.0.1:18732 -t "%~dp0public" "%~dp0router.php"
