# HomyCloud

Русский | [English](#english)

## Русский

HomyCloud — desktop-приложение на Electron для SoundCloud с Discord Rich Presence, горячими клавишами и кастомным интерфейсом.

### Возможности
- Воспроизведение SoundCloud во встроенном `webview`
- Discord Rich Presence
- Настройки UI и горячих клавиш
- Windows installer (`Setup.exe`), portable (`.exe`) и `.zip` сборка

### Установка зависимостей
```bash
npm install
```

### Запуск в разработке
```bash
npm start
```

### Сборка
```bash
npm run dist
```

Отдельные команды:
```bash
npm run dist:exe
npm run dist:portable
npm run dist:zip
```

Артефакты сборки находятся в папке `dist/`.

### Сайт (GitHub Pages)
Лендинг находится в `docs/index.html`.

### Лицензия
Проект распространяется по лицензии MIT. См. файл `LICENSE`.

---

## English

HomyCloud is an Electron desktop app for SoundCloud with Discord Rich Presence, hotkeys, and a customizable UI.

### Features
- SoundCloud playback in an embedded `webview`
- Discord Rich Presence
- UI and hotkey settings
- Windows installer (`Setup.exe`), portable (`.exe`), and `.zip` builds

### Install dependencies
```bash
npm install
```

### Run in development
```bash
npm start
```

### Build
```bash
npm run dist
```

Separate commands:
```bash
npm run dist:exe
npm run dist:portable
npm run dist:zip
```

Build artifacts are generated in `dist/`.

### Website (GitHub Pages)
Landing page is located at `docs/index.html`.

### License
This project is licensed under the MIT License. See `LICENSE`.
