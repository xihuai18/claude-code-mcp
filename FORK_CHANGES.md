# Fork changes / Cambios de este fork

This fork of [`xihuai18/claude-code-mcp`](https://github.com/xihuai18/claude-code-mcp) adds two small, test-covered fixes to `claude_code_check` (`poll` action). No dependency, build, or public-API changes beyond one new optional response field.

Este fork de [`xihuai18/claude-code-mcp`](https://github.com/xihuai18/claude-code-mcp) añade dos arreglos pequeños, cubiertos por tests, a `claude_code_check` (acción `poll`). Sin cambios de dependencias, de build, ni de API pública salvo un campo opcional nuevo en la respuesta.

---

## English

### 1. Fix: stuck cursor when `pollOptions.maxBytes` can't fit a single event

**File:** `src/tools/claude-code-check.ts` (`buildResult`)

When `pollOptions.maxBytes` is set and a single buffered event is larger than the byte budget, `capEventsByBytes` correctly returns zero events — but the original code then fell back to `nextCursor = cursorResetTo ?? input.cursor ?? 0`, i.e. **the same cursor the caller sent in**. A client that re-polls with that cursor, using the same `maxBytes`, would retry the same oversized event forever and never make progress: an infinite poll loop with no error and no data.

**Fix:** `nextCursor` now always advances past the oversized event, and `truncatedFields` gets a new marker `"event_dropped_oversized"` so callers can tell data was dropped rather than just paginated.

**Tests added** (`tests/claude-code-check.test.ts`):
- `"advances the cursor past a single event that alone exceeds maxBytes (no infinite poll loop)"` — reproduces the stuck state against the original code, confirms the fix, and confirms a follow-up poll with the new cursor makes real progress.

### 2. Transparency: `filteredEventCount` in poll responses

**Files:** `src/tools/claude-code-check.ts`, `src/types.ts`

In `minimal`/`delta_compact` response modes (the defaults), noisy `progress` events (`tool_progress`, `auth_status`, etc.) and duplicate terminal `result`/`error` events are silently dropped from the `events` array returned by `poll` — intentional, to keep payloads small. But `eventCount` reported by `claude_code_session` still counts them, which looks like a pagination bug when it isn't.

**Fix:** `CheckResult` gets a new optional field, `filteredEventCount?: number`, set only when `> 0`, reporting how many events in the current window were excluded by this intentional filtering (not by `maxEvents`/`maxBytes` pagination, which is unaffected).

**Test added:** confirms the field appears with the correct count when noisy events are filtered, and is `undefined` when nothing is filtered.

### Verification

- `npm run typecheck`: clean.
- `npm test`: 225/225 passing (19 test files), no regressions.
- Both changes were built and validated in an isolated sandbox copy before being applied here, and cross-checked against the upstream diff.

### Not changed

- No dependency bumps, no `package.json`/`CHANGELOG.md` edits from upstream, no build config changes beyond `npm audit fix` (no `--force`), applied to `package-lock.json` only.
- `npm audit` findings were reviewed separately: after `npm audit fix` (no `--force`), the remaining 3 low/moderate advisories are either dev-tooling only (`esbuild`) or in a transitive HTTP-transport dependency (`@hono/node-server`, via `@modelcontextprotocol/sdk`) that this project never imports — confirmed by grepping both `src/` and the compiled `dist/index.js` for any reference to `hono`. Fixing it would require a minor SDK bump for no real reduction in exposure, so it was left alone.

---

## Español

### 1. Arreglo: cursor atascado cuando `pollOptions.maxBytes` no puede con un solo evento

**Archivo:** `src/tools/claude-code-check.ts` (`buildResult`)

Cuando se fija `pollOptions.maxBytes` y un único evento en buffer pesa más que el presupuesto de bytes, `capEventsByBytes` devuelve correctamente cero eventos — pero el código original entonces caía a `nextCursor = cursorResetTo ?? input.cursor ?? 0`, es decir, **el mismo cursor que había mandado el cliente**. Un cliente que repitiera el `poll` con ese cursor, usando el mismo `maxBytes`, reintentaría el mismo evento sobredimensionado para siempre, sin avanzar nunca: un bucle infinito de polling, sin error y sin datos.

**Arreglo:** `nextCursor` ahora siempre avanza más allá del evento sobredimensionado, y `truncatedFields` recibe una marca nueva, `"event_dropped_oversized"`, para que quien llama sepa que se descartó contenido (no que solo se paginó).

**Tests añadidos** (`tests/claude-code-check.test.ts`):
- `"advances the cursor past a single event that alone exceeds maxBytes (no infinite poll loop)"` — reproduce el atasco contra el código original, confirma el arreglo, y confirma que un poll posterior con el nuevo cursor avanza de verdad.

### 2. Transparencia: `filteredEventCount` en las respuestas de poll

**Archivos:** `src/tools/claude-code-check.ts`, `src/types.ts`

En los modos de respuesta `minimal`/`delta_compact` (los que se usan por defecto), los eventos `progress` ruidosos (`tool_progress`, `auth_status`, etc.) y los eventos terminales `result`/`error` duplicados se descartan silenciosamente del array `events` que devuelve `poll` — intencionado, para mantener las respuestas ligeras. Pero el `eventCount` que reporta `claude_code_session` sigue contándolos, lo cual parece un bug de paginación sin serlo.

**Arreglo:** `CheckResult` gana un campo opcional nuevo, `filteredEventCount?: number`, que solo aparece cuando es `> 0`, indicando cuántos eventos de la ventana actual se excluyeron por este filtrado intencionado (no por la paginación de `maxEvents`/`maxBytes`, que no se ve afectada).

**Test añadido:** confirma que el campo aparece con el valor correcto cuando se filtran eventos ruidosos, y que es `undefined` cuando no se filtra nada.

### Verificación

- `npm run typecheck`: limpio.
- `npm test`: 225/225 pasando (19 archivos de test), sin regresiones.
- Ambos cambios se construyeron y validaron en una copia sandbox aislada antes de aplicarse aquí, y se contrastaron contra el diff subido.

### Lo que no se tocó

- Sin subidas de versión de dependencias, sin tocar `package.json`/`CHANGELOG.md` del original, sin cambios de configuración de build más allá de `npm audit fix` (sin `--force`), aplicado solo a `package-lock.json`.
- Los avisos de `npm audit` se revisaron aparte: tras `npm audit fix` (sin `--force`), los 3 avisos bajos/moderados que quedan son o bien solo de herramientas de desarrollo (`esbuild`), o de una dependencia transitiva de transporte HTTP (`@hono/node-server`, vía `@modelcontextprotocol/sdk`) que este proyecto nunca importa — confirmado buscando `hono` tanto en `src/` como en el `dist/index.js` compilado, sin ningún resultado. Arreglarlo exigiría subir de versión el SDK sin reducir de verdad la exposición real, así que se dejó como está.
