# Альфа-Будущее — профориентационный Telegram Mini App

Короткий тест (12 вопросов) для офлайн-активности «Фабрика Стажёров». Подросток проходит тест → получает топ-профессию + 3 ближайших → оставляет контакт → получает инструкцию по бейджику и ссылку на @alfafuture. Контакты пишутся в локальный SQLite-файл рядом с сервером.

## Структура

```
profession/
├── webapp/                 # статичный фронт (HTML/CSS/JS, без сборки)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── assets/maneki.gif
│   └── content/
│       ├── strings.json     # все тексты экранов
│       ├── professions.json # 25 профессий
│       └── questions.json   # 12 вопросов + веса
└── server/                 # бот + HTTP-эндпойнт для лидов
    ├── main.py
    ├── storage.py          # SQLite (stdlib sqlite3)
    ├── requirements.txt
    └── .env.example
```

## Что менять, когда хочется поправить контент

| Что | Где |
|---|---|
| Тексты экранов (welcome, outro, шаблон результата, форма) | `webapp/content/strings.json` |
| Ссылка на канал / на политику обработки ПД | `webapp/content/strings.json` (`outro.channel_url`, `lead.consent_link_url`) |
| URL бэка для отправки лидов | `webapp/content/strings.json` → `api.base_url` |
| Добавить/убрать профессию | `webapp/content/professions.json` |
| Изменить вопрос или вариант ответа / веса | `webapp/content/questions.json` |
| Цвета и шрифт | переменные в начале `webapp/styles.css` (`--primary`, `--font` и т.д.) |

После правки JSON просто перезагрузить страницу — никакой пересборки.

### Алгоритм подсчёта

Без LLM. У каждого варианта ответа — словарь весов на профессии. На каждом ответе суммируем веса; в конце для каждой профессии считаем `percent = round(100 * сумма / максимально_возможное)`. Сортируем убыванием — топ-1 = главный результат, топ-2/3/4 = «также подойдут».

Максимально возможное по профессии = сумма максимальных весов этой профессии в каждом вопросе. Это значит, что 84% реально читается как «набрал 84% от максимума для этой роли».

При загрузке фронт один раз печатает в консоль `[alfafuture] maxScores per profession:` — этим удобно проверять баланс весов после правок.

## Запуск

> Для прод-деплоя в Selectel есть пошаговая инструкция: [DEPLOY.md](DEPLOY.md).

### 1. Telegram-бот

1. Открыть [@BotFather](https://t.me/BotFather), `/newbot`, получить токен.
2. У того же `@BotFather`: `/mybots` → выбрать бота → **Bot Settings → Menu Button → Configure menu button** → указать URL вашего задеплоенного `webapp/` (см. шаг 3). Подпись кнопки — например, «Пройти тест».

### 2. SQLite

Делать ничего не надо — `leads.db` создаётся автоматически при первом запросе. Путь задаётся переменной `DB_PATH` в `.env` (по умолчанию `./leads.db` рядом с `main.py`).

Таблица создаётся при старте сервера, при первой записи. Резервная копия — обычный `cp leads.db backup.db` (SQLite в режиме WAL это переживёт).

### 3. Деплой `webapp/`

Любой HTTPS-хостинг статики:

- **GitHub Pages**: запушить папку `webapp/` в репозиторий → Settings → Pages.
- **Vercel / Netlify / Cloudflare Pages**: drag-and-drop папки `webapp/`.

После деплоя в `webapp/content/strings.json` → `api.base_url` указать публичный URL сервера (см. шаг 4).

### 4. Сервер

```bash
cd server
cp .env.example .env
# отредактировать .env: TELEGRAM_BOT_TOKEN, WEBAPP_URL, ALLOWED_ORIGINS, при желании DB_PATH
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
```

Для прода нужно поднять за HTTPS-реверс-прокси (nginx / Caddy / Cloudflare Tunnel) — Telegram WebApp требует HTTPS, и браузер запретит CORS-запрос с `https://` на `http://`.

### 5. Локальная отладка фронта

```bash
cd webapp
python3 -m http.server 8000
# открыть http://localhost:8000
```

Telegram WebApp SDK на десктопе работает в режиме «киоск»: интерфейс прокликается, лид уйдёт с `source=kiosk`. Для теста формы можно временно поставить `api.base_url = "http://localhost:8080"` в `strings.json` и запустить локальный сервер.

## Таблица `leads` (SQLite)

Колонки: `id, timestamp_iso, name, contact_type, contact_value, top_profession_id, top_percent, second_id, second_percent, third_id, third_percent, fourth_id, fourth_percent, source, tg_user_id, tg_username, user_agent, consent`.

`source` = `telegram` (запущено из бота, прошла проверка initData) или `kiosk` (открыто напрямую в браузере, например на корпоративном планшете).

### Выгрузка в CSV/Excel

```bash
# CSV для Excel/Numbers
sqlite3 -header -csv server/leads.db "SELECT * FROM leads ORDER BY id" > leads.csv

# Посчитать, сколько каждая профессия выпала топом
sqlite3 -header -column server/leads.db \
  "SELECT top_profession_id, COUNT(*) c FROM leads GROUP BY 1 ORDER BY c DESC"

# Лиды за сегодня
sqlite3 -header -column server/leads.db \
  "SELECT timestamp_iso, name, contact_value FROM leads WHERE timestamp_iso > date('now')"
```

## Минимальная защита эндпойнта

- CORS — только домены из `ALLOWED_ORIGINS`.
- Honeypot-поле в форме (скрыто стилями) — заполненное = бот, тихо игнорируем.
- Rate-limit — 10 отправок в минуту с одного IP.
- Если пришёл `tg_init_data` — проверяется HMAC-подпись Telegram. Невалидная → лид всё равно сохраняется как `kiosk`, не отбрасывается (так дружелюбнее к UX).
- Капчи нет — для подростков на оффлайне это перебор.
