# CLAUDE.md — Standing Instructions

These instructions apply to every session in this project. Read them before doing any work.

---

## Spec maintenance (required)

At the end of every session where files were changed or decisions were made, update `SPEC.md` to reflect the current state of the project — including the data schema, architecture decisions, active features, open questions, and anything a collaborator would need to get up to speed quickly.

---

## Project basics

- The entire app lives in one file: `public/index.html`. Do not create additional JS, CSS, or HTML files unless explicitly asked.
- Deployed to Firebase Hosting. Deploy command: `firebase deploy --only hosting`
- Do NOT use `git push` to deploy — the GitHub Actions workflow has a broken `npm ci` step (no `package.json`). Always use the Firebase CLI directly.
- `public/` is the hosted directory per `firebase.json`.

## Code conventions

- **localStorage-first pattern**: Always read from `localStorage` first for instant UI response, fall back to Firestore on first load, and write to both simultaneously. Never block UI on a Firestore read.
- **No external libraries**: No Chart.js, no React, no build step. All charts are hand-built SVG. Keep it that way unless explicitly told otherwise.
- **Async safety**: Always wrap Firestore `.get()` calls in try/catch. Unhandled rejections cause silent UI failures.
- **Data is static**: Meal plans, recipes, prep tasks, and shopping lists are hardcoded constants (`MEALS`, `RECIPES`, `PREP_DATA`, `SHOP_ITEMS`). Only user state (check-ins, meal completion, prep completion, shop checks) is persisted.

## Layout rules

- Mobile-first. Breakpoint for desktop layout: `min-width: 900px`.
- Mobile: bottom fixed nav (`#mobile-nav`), top bar (`#top-bar`) with week nav + profile.
- Desktop: left rail (`#rail`, 220px) with logo + vertical nav, top header bar with page title + week nav + profile.
- The top bar always stays visible across all tabs. Only the week nav area (`#week-nav-area`) hides on tabs where it isn't relevant (Prep, Shop, Recipes).

## Navigation

- `showPage(name, btn)` handles all tab switching. It updates both `.nb` (mobile) and `.rn` (rail) nav button states via `data-page` attributes.
- `activePage` tracks the current page and routes week nav to the right render function.
- `TOP_BAR_PAGES = new Set(['plan', 'tools'])` — pages that show the week navigator.

## Firestore schema

See `SPEC.md` for the full schema. All user data lives in `users/{uid}` as a flat key/value document. Do not change the key naming convention without updating SPEC.md.

## Deployment checklist

Before deploying:
1. Verify no duplicate element IDs in static HTML (JS template strings are OK)
2. Verify no calls to deleted functions remain in the init block or event handlers
3. Run `firebase deploy --only hosting` and confirm "release complete"
