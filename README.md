# Practice worksheets

Static weekly practice worksheets and a progress dashboard, served from GitHub Pages.

No learning data, answers or personal records are stored in this repository. Scores live in a
hosted JSON store and are read in the browser with a key that can only read and update, never
delete or create.

## Layout

| Path | What it is |
|---|---|
| `index.html` | progress dashboard |
| `mason/`, `elysia/` | one weekly worksheet per child |
| `assets/` | shared design system, data client and app code |
| `scripts/kh.py` | data CLI: pull, push, status, validate, backup |
| `scripts/test.mjs` | tests for the marking engine |
| `schema/` | JSON Schema for the data shape |

## Running it locally

```sh
python3 -m http.server 8000
# then open http://localhost:8000/
```

The pages are ES modules, so they need to be served over HTTP rather than opened as files.

## Tests

```sh
node scripts/test.mjs
```
