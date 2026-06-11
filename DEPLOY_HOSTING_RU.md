# Как запустить Bot Panel UI на хостинге

Этот набор файлов содержит статическую веб-UI часть панели (`index.html`, `styles.css`, `app.js`). Интерфейс рассчитан на backend из FastAPI-кода, где есть endpoints `/api/auth/*`, `/api/chats/*`, `/api/photo/*`, `/api/file/*` и SSE `/api/chats/{chat_id}/stream`.

## Что внутри

Структура файлов должна быть такой:

```text
web/static/index.html
web/static/static/styles.css
web/static/static/app.js
main.py                 # готовый entrypoint для запуска бота + сайта на хостинге
```

Папку `web/static` ожидает твой FastAPI-код:

```python
STATIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC / "static")), name="static_assets")
```

То есть HTML лежит в `web/static/index.html`, а CSS/JS — в `web/static/static/`. Файл `main.py` — это готовый вариант твоего файла запуска с hosting-friendly стартом сайта.

---

## Вариант 1 — запуск вместе с твоим FastAPI backend

Это лучший вариант, потому что UI сразу будет обращаться к API на том же домене и не будет проблем с CORS/cookie.

### 1. Получи файлы из GitHub

Из-за ограничения Codex Cloud бинарные `.zip` файлы не добавляются в PR: кнопка создания PR может показывать ошибку «Бинарные файлы не поддерживаются». Поэтому архив не хранится в репозитории как отдельный файл.

После merge PR скачай проект обычной кнопкой GitHub:

```text
Code → Download ZIP
```

В скачанном архиве будут `web/static`, `main.py` и этот гайд. Если нужен отдельный архив только панели, его можно собрать уже после скачивания проекта:

```bash
zip -r bot-panel-ui.zip web/static DEPLOY_HOSTING_RU.md main.py
```

### 2. Проверь переменные окружения

Минимально нужны:

```bash
BOT_TOKEN="токен_твоего_бота"
WEB_JWT_SECRET="длинный_секрет_для_jwt_минимум_32_символа"
WEB_ADMIN_LOGIN="твой_логин"
WEB_ADMIN_PASSWORD="твой_пароль"
WEB_ADMIN_NAME="твое_имя"
```

Их можно положить в `.env`, если backend загружает `.env`.

### 3. Запусти backend

Пример через uvicorn, если файл backend называется `web/server.py`, а FastAPI app называется `app`:

```bash
uvicorn web.server:app --host 0.0.0.0 --port 8080
```

Если у тебя запуск идёт через функцию `start_web_server()`, запускай так, как предусмотрено в проекте бота.


### 3.1. Если используешь добавленный `main.py`

В `main.py` уже добавлен запуск сайта через:

```python
asyncio.create_task(start_hosting_site())
```

Он сам берёт порт из переменных окружения:

```bash
PORT=8080        # обычно так дают порт Render/Railway/Fly.io
WEB_PORT=24608   # запасной вариант для VPS
WEB_HOST=0.0.0.0
WEB_ENABLED=1
WEB_PUBLIC_URL="https://твой-домен.ru"
```

Приоритет такой: сначала `PORT`, потом `WEB_PORT`, если ничего нет — `24608`. Поэтому на большинстве PaaS-хостингов достаточно указать команду запуска:

```bash
python main.py
```

### 4. Открой панель

```text
http://IP_СЕРВЕРА:8080
```

Или через домен:

```text
https://твой-домен.ru
```

---

## Вариант 2 — Nginx + FastAPI на одном домене

Подходит для VPS/VDS.

### 1. Backend слушает локально

Например:

```bash
uvicorn web.server:app --host 127.0.0.1 --port 8080
```

### 2. Nginx проксирует всё на FastAPI

Пример конфига:

```nginx
server {
    listen 80;
    server_name твой-домен.ru;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Для SSE-стрима сообщений важно отключить буферизацию.
    location /api/chats/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
    }
}
```

После настройки:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 3. HTTPS

Рекомендуется сразу включить HTTPS через certbot:

```bash
sudo certbot --nginx -d твой-домен.ru
```

---

## Вариант 3 — только посмотреть UI без backend

Так можно увидеть экран логина и проверить, что статика открывается. API работать не будет без backend.

```bash
python3 -m http.server 9000 --directory web/static
```

Открыть:

```text
http://localhost:9000
```

---

## Вариант 4 — обычный shared-хостинг без Python

Если хостинг умеет только HTML/CSS/JS, то полноценно панель не заработает, потому что ей нужен FastAPI backend и Telegram bot token на сервере.

Можно загрузить только содержимое `web/static`, но:

- авторизация `/api/auth/login` не будет работать;
- чаты `/api/chats` не будут грузиться;
- отправка сообщений и файлов не будет работать;
- модерация не будет работать.

Для полноценной работы нужен VPS/VDS, Render/Railway/Fly.io, Docker-хостинг или любой хостинг с Python backend.

---

## Важные замечания

1. UI обращается к API относительными путями, например `/api/chats`, поэтому лучше держать frontend и backend на одном домене.
2. Для отправки больших файлов настрой `client_max_body_size` в Nginx и лимиты на стороне backend.
3. Для live-обновления сообщений нужен SSE endpoint `/api/chats/{chat_id}/stream`; в reverse proxy нельзя буферизовать этот поток.
4. Если используешь cookie-авторизацию, запускай панель через HTTPS.
5. Разбан (`unban`) в UI отправляется как `action=unban`; если backend ещё не поддерживает этот action, нужно добавить его на backend или кнопка покажет ошибку.
