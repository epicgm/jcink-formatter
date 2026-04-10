# Jcink Formatter

A web app for formatting Jcink forum posts, hosted on GitHub Pages with Supabase auth.

## Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/epicgm/jcink-formatter.git
   cd jcink-formatter
   ```

2. **Create your local config**
   ```bash
   cp config.example.js config.js
   ```
   Then open `config.js` and fill in your Supabase URL and anon key.
   `config.js` is gitignored — never commit it.

3. **Open locally**
   Open `index.html` in a browser (or use a local server like VS Code Live Server).

## Deployment (GitHub Pages)

For production, `config.js` must be present on the server.
A future phase will add a GitHub Actions workflow to generate it from repository secrets.

## Project structure

```
index.html          Login screen
home.html           Main app (placeholder)
app.js              Supabase client + auth logic
styles.css          Mobile-first styles
config.js           Local credentials (gitignored)
config.example.js   Credentials template (committed, no secrets)
```
