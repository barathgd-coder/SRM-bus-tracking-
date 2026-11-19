# SRM Trichy Bus Tracking – Backend + Database

Node.js server with a SQLite database. **No `npm install` needed** (no packages).

## Run
1. Install Node.js **22.13 or newer** (https://nodejs.org).
2. In this folder run:  `node server.js`
3. Open http://localhost:3000  (other devices on the same Wi-Fi: `http://<your-PC-IP>:3000`)

The database file is created automatically at `data/srm-bus.db` on first start
(60 drivers and the 100 bus pass codes are loaded from `seed.json`).
To reset everything, stop the server and delete the `data/` folder.

## Settings (environment variables)
| Name | Default |
|---|---|
| PORT | 3000 |
| ADMIN_USER | ADMIN1234 |
| ADMIN_PASS | Admin1234 |
| DB_FILE | data/srm-bus.db |

Example: `ADMIN_PASS=MyStrongPass node server.js`  (Windows PowerShell: `$env:ADMIN_PASS="MyStrongPass"; node server.js`)

## Database tables
`drivers` (name, age, phone, password, route, last login, login count) ·
`students` (name, pass code, bus, route, first/last login, count) ·
`logins` (full history of every driver/student login) ·
`passes` (the 100 pass codes, active/disabled) ·
`bus_state` (crowd, status, delay, GPS per bus) ·
`alerts` · `messages`

## What is saved
* Driver logs in → driver name, bus, route and time saved; login count updated.
* Student logs in (name + valid pass code) → student name, pass code, bus, route and time saved.
* Admin panel → DRIVERS / STUDENTS / LOGINS tabs read straight from the database (with CSV download).
* Student/driver messages, alerts, crowd and bus status are stored in the database and shared live (refresh every 2 s).

## Notes
* Student pass codes are checked on the server; they are no longer inside the web page.
* Admin login uses a token kept in memory (log in again after a server restart).
* Phones only allow GPS ("Use device GPS") on **HTTPS** pages or localhost. For real use, host behind HTTPS
  (e.g. Render, Railway, or Nginx + Let's Encrypt). Use a host with a persistent disk so `data/` is kept.
* Bus positions are still a demo simulation unless a driver turns on device GPS.
