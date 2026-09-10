# Design-token prototype

One proposed shadcn-compatible token set, rendered in three deliberately
different contexts and switchable with `?variant=`. This is throwaway code for
[Prototype: design tokens and dark mode from v1's identity](https://github.com/a-movie-club/movie_club_v2/issues/11),
not an application scaffold.

Run it from the repository root:

```sh
python3 -m http.server 4173 --directory prototype/design-tokens
```

Then open <http://localhost:4173/?variant=A&theme=light&font=system>.

- `variant=A`: token and component specimen
- `variant=B`: club-session hero
- `variant=C`: admin and state stress test
- `theme=light|dark`: proposed light and dark palettes
- `font=system|legacy`: portable system stack or v1's literal stack

The floating switcher and all prototype code stay on the throwaway
`prototype/design-tokens` branch.
