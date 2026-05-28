# Деплой в Selectel

Один облачный сервер на Selectel + nginx + systemd. Всё в одном месте: nginx раздаёт `webapp/` как статику и проксирует `/api/*` на python-процесс, который пишет лиды в SQLite. HTTPS — через Let's Encrypt.

Этого хватает на офлайн-активность с парой сотен участников. Ниже всё пошагово.

---

## 0. Что заранее

- Аккаунт на [my.selectel.ru](https://my.selectel.ru/) с пополненным балансом (минимум ~500 ₽, реально хватит надолго).
- Домен. Подойдёт любой — можно купить тут же в Selectel (Маркетплейс → Домены) или у любого регистратора (reg.ru и т.п.). Без домена не выпустить Let's Encrypt-сертификат, а без HTTPS Telegram WebApp работать не будет. Дальше в примерах используется `alfa-future.example.com` — замени на свой.
- Токен Telegram-бота от [@BotFather](https://t.me/BotFather).
- SSH-ключ на твоей машине (`~/.ssh/id_ed25519.pub`). Если нет: `ssh-keygen -t ed25519`.

---

## 1. Создать сервер

1. Панель Selectel → **Облачная платформа** → **Серверы** → **Создать сервер**.
2. **Регион**: Москва (`ru-1`) или СПб (`ru-2`) — для России без разницы.
3. **Источник** → **Готовый образ** → **Ubuntu 24.04 LTS**.
4. **Конфигурация**: фиксированная, линейка **Shared Line** (с разделяемыми ядрами).
   Минимум: **1 vCPU / 1 GB RAM / 10 GB SSD**. ~250 ₽/мес. Под этот проект хватит за глаза.
5. **Сеть** → подсеть с публичным IPv4. **Плавающий IP** включать не обязательно — белый IP добавится автоматически.
6. **Доступ** → загрузить свой SSH-ключ (или вставить публичную часть).
7. **Создать**.

Через минуту в карточке сервера появится **публичный IP** — запиши.

---

## 2. Привязать домен

В DNS-зоне домена (если домен в Selectel — раздел **Маркетплейс → Домены → Управление зонами**) создай две A-записи:

```
alfa-future.example.com.        A    <ВАШ_IP>     TTL 300
www.alfa-future.example.com.    A    <ВАШ_IP>     TTL 300
```

Подожди 1–5 минут, проверь:
```bash
dig +short alfa-future.example.com   # должен вернуть твой IP
```

---

## 3. Подключиться и базово укрепить сервер

```bash
ssh root@<ВАШ_IP>

# обновления
apt update && apt -y upgrade

# отдельный пользователь
adduser --gecos "" --disabled-password deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# отключить root по ssh (опционально, но желательно)
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh

# фаервол: пускаем только ssh + http(s)
apt -y install ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Выйти из сессии root и зайти под `deploy`:
```bash
exit
ssh deploy@<ВАШ_IP>
```

---

## 4. Залить код

Самое простое — через git. Запушь репозиторий на GitHub/GitLab (приватный — нормально, если ключ деплоя добавлен) и склонируй.

```bash
sudo apt -y install git python3-venv nginx
sudo mkdir -p /opt/profession
sudo chown deploy:deploy /opt/profession
cd /opt
git clone https://github.com/<твой-юзер>/profession.git
cd profession
```

Альтернатива без git — `scp` с локальной машины:
```bash
# на ЛОКАЛЬНОЙ машине
scp -r /Users/m.khovrichev/profession deploy@<ВАШ_IP>:/opt/
```

---

## 5. Запустить серверный процесс

```bash
cd /opt/profession/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

cp .env.example .env
nano .env
```

В `.env` заполнить:
```
TELEGRAM_BOT_TOKEN=123456:xxxxxxxxxxxxx
WEBAPP_URL=https://alfa-future.example.com
DB_PATH=/opt/profession/server/leads.db
HTTP_HOST=127.0.0.1
HTTP_PORT=8080
ALLOWED_ORIGINS=https://alfa-future.example.com
```

`HTTP_HOST=127.0.0.1` — биндимся только на локалхост, наружу торчит только nginx.

Проверить, что запускается:
```bash
.venv/bin/python main.py
# должно показать "HTTP server listening on 127.0.0.1:8080" и подключиться к Telegram
# Ctrl+C
```

Если запустился — оформляем как systemd-сервис, чтобы стартовал автоматически.

```bash
sudo tee /etc/systemd/system/profession.service > /dev/null <<'EOF'
[Unit]
Description=Alfa-Future profession test (bot + lead API)
After=network.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/opt/profession/server
EnvironmentFile=/opt/profession/server/.env
ExecStart=/opt/profession/server/.venv/bin/python main.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now profession
sudo systemctl status profession   # должно быть active (running)
sudo journalctl -u profession -f   # смотреть логи в реальном времени, Ctrl+C
```

---

## 6. Поправить `api.base_url` во фронте

В [webapp/content/strings.json](webapp/content/strings.json):
```json
"api": {
  "base_url": ""
}
```

Пустая строка → фронт будет постить на `/api/lead` относительно своего домена. Так как nginx раздаёт и фронт, и API на одном домене — это сработает.

Если ты деплоил с локальной машины через `scp` — после правки `strings.json` нужно перезалить. Если через git — закоммить, запушь, и на сервере:
```bash
cd /opt/profession && git pull
```

Перезагрузка `nginx` для этого **не нужна** — это статический JSON, фронт подтянет на следующем открытии страницы.

---

## 7. Настроить nginx

```bash
sudo tee /etc/nginx/sites-available/profession > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name alfa-future.example.com www.alfa-future.example.com;

    # webroot для certbot — этот блок нужен только до выпуска сертификата
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # всё остальное временно
    location / {
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }
}
EOF

sudo mkdir -p /var/www/certbot
sudo ln -s /etc/nginx/sites-available/profession /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Проверить:
```bash
curl http://alfa-future.example.com/   # должно ответить "ok"
```

---

## 8. HTTPS через Let's Encrypt

```bash
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx \
  -d alfa-future.example.com -d www.alfa-future.example.com \
  --email you@example.com --agree-tos --no-eff-email --redirect
```

`certbot` сам пропишет 443-блок в nginx-конфиге и поставит редирект 80→443. Автообновление сертификата уже в кроне (`/etc/cron.d/certbot`).

---

## 9. Финальный nginx-конфиг

После certbot открой `/etc/nginx/sites-available/profession` и подмени всё на это (`certbot` сохранил пути к сертификату — подставь их из текущего файла, они будут вида `/etc/letsencrypt/live/alfa-future.example.com/...`):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name alfa-future.example.com www.alfa-future.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name alfa-future.example.com www.alfa-future.example.com;

    ssl_certificate     /etc/letsencrypt/live/alfa-future.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alfa-future.example.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # статика — фронт mini-app
    root /opt/profession/webapp;
    index index.html;

    location = /healthz {
        proxy_pass http://127.0.0.1:8080/healthz;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 32k;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # JSON-контент — не кешируем, чтобы правки в strings.json подхватывались сразу
    location ~ ^/content/.*\.json$ {
        add_header Cache-Control "no-store";
        try_files $uri =404;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Открой `https://alfa-future.example.com` в браузере — должен открыться welcome-экран с маняки-неко.

---

## 10. Привязать к боту

В [@BotFather](https://t.me/BotFather):
1. `/mybots` → выбрать бота.
2. **Bot Settings → Menu Button → Configure menu button**.
3. Прислать URL: `https://alfa-future.example.com` и подпись кнопки, например «Пройти тест».

Открыть бота в Telegram → нажать иконку меню рядом со скрепкой → откроется Mini App.

---

## 11. Бэкап `leads.db`

SQLite в режиме WAL переживает обычное копирование. Простейший вариант — крон раз в час сохраняет копию в `/opt/profession/backups`:

```bash
sudo mkdir -p /opt/profession/backups
sudo chown deploy:deploy /opt/profession/backups

crontab -e
# вписать:
0 * * * * sqlite3 /opt/profession/server/leads.db ".backup /opt/profession/backups/leads-$(date +\%Y\%m\%d-\%H).db" && find /opt/profession/backups -name 'leads-*.db' -mtime +14 -delete
```

Скачать на свой ноут актуальную базу:
```bash
scp deploy@<ВАШ_IP>:/opt/profession/server/leads.db ./
sqlite3 -header -csv leads.db "SELECT * FROM leads" > leads.csv
open leads.csv   # откроется в Numbers/Excel
```

---

## 12. Когда нужно обновить фронт или вопросы

```bash
ssh deploy@<ВАШ_IP>
cd /opt/profession && git pull            # или re-scp
# для server/ если поменялся:
sudo systemctl restart profession
# для webapp/ ничего не надо — nginx раздаст новые файлы сам
```

---

## Что смотреть, если что-то пошло не так

| Симптом | Где смотреть |
|---|---|
| Бот не отвечает на `/start` | `sudo journalctl -u profession -n 100` |
| Mini App белый экран | DevTools браузера → Console + Network. Чаще всего — `api.base_url` неправильный или 404 на JSON-файл |
| Форма «не получилось отправить» | `journalctl -u profession -f` + проверить `ALLOWED_ORIGINS` в `.env` |
| nginx 502 | python-процесс упал. `systemctl status profession`, `journalctl -u profession` |
| Сертификат истёк | `sudo certbot renew --dry-run` для диагностики, обычно крон сам обновляет |

---

## Альтернатива: статику в Selectel S3, сервер на VPS

Если хочется чище разнести: webapp выложить в **Object Storage** Selectel (тарификация почти бесплатная для такого объёма), а сервер оставить на VPS.

1. Создать **Контейнер** в Selectel Object Storage, тип **публичный**.
2. Загрузить содержимое `webapp/` через панель или `s3cmd`.
3. Включить **Статический сайт** в настройках контейнера (`index.html` как корневой).
4. Привязать домен webapp-поддомена через CNAME, прикрыть Cloudflare если нужен свой сертификат.
5. На VPS оставить только API-сервер (тот же systemd-сервис, тот же nginx + certbot, но без `root /opt/profession/webapp`).
6. В `strings.json` указать полный URL API: `"base_url": "https://api.alfa-future.example.com"`.
7. В `ALLOWED_ORIGINS` сервера прописать домен фронта.

Для разовой активности это лишние движения — одного VPS достаточно.
