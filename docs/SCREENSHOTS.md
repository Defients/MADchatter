# Screenshot guide

[← Back to the README](../README.md)

The README already uses the existing MADchatter logo. The most useful next asset is a real screenshot of the app in use: it should help a streamer understand the workspace at a glance.

## Recommended shots

| Priority | Suggested filename | What to show |
| --- | --- | --- |
| 1 — Main image | `forge-workspace.png` | The full desktop workspace with representative chat, a completed batch of variants, and the Tuning Deck visible. Close onboarding, settings, and unrelated overlays. |
| 2 — Autonomy | `autoforge-hud.png` | The HUD with a readable decision, reason, confidence, and Dry Run visibly enabled. |
| 3 — Multiple identities | `multi-bot-panel.png` | Two or three clearly distinguished Twitch or Kick bot identities and their persona controls. |
| 4 — Optional detail | `memory-panel.png` | A small set of readable, shareable memories, profiles, or pinned context. |

One strong main image is enough to improve the README. Add supporting shots only when they explain something the main image cannot.

## Capture and presentation

- Capture at the app's native desktop size, ideally **1920 × 1080** or larger, using PNG for readable text.
- Use your preferred theme consistently in the first two shots. A separate theme comparison can come later.
- Keep relevant panel headings and controls in view. Trim browser chrome and unused desktop space.
- Use real app output. If a demonstration uses staged/sample content, label it as a demo.
- Use content you are comfortable publishing. Hide API keys, tokens, private conversations, account details you do not want public, and unrelated desktop windows.
- Keep original captures. Optimize copies for the README without shrinking the text into illegibility; aim for roughly **1 MB or less per image** where practical.

## Adding images

Store finished screenshots in `docs/images/`. Add the main image directly after the README introduction, replacing the screenshot comment. With `forge-workspace.png` present, this Markdown works from the repository root:

```markdown
![MADchatter workspace showing live chat, generated reply variants, and the Tuning Deck](docs/images/forge-workspace.png)

*Chat context on the left, reply variants in the center, and personality controls on the right.*
```

Only add image references after the corresponding files exist. Use descriptive alt text and a brief caption that explains the visible workflow. Keep the full README readable without expanding a gallery.

For a future GitHub social preview, adapt the existing logo into a separate banner with the line **“Read the room. Forge the reply.”** A social banner is optional; the real app screenshot comes first.
