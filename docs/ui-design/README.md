# Estoc design language: copper and verdigris

Estoc has one look, and it is dark. This document holds the rules. The values live in the variables at the top of `app/src/style.css`; when the two disagree, fix whichever is wrong until they match.

There is no light look for now. If one is made later, derive it from the relations below instead of brightening the swatches.

## In one line

On one cool ground, what arrives is verdigris and what you send is copper.

Verdigris is what copper turns into as it weathers. That reading came after the fact and is kept as a way to remember which colour is whose. The colours themselves were picked because they looked right.

## Relations

The relations between colours matter more than any single value. Change a colour only in a way that keeps all four true.

1. **Surfaces share one hue and differ in lightness.** Ground, surface, raised and line sit at hue 198 to 200, with lightness 12, 16, 18 and 26. One layer up is one step lighter.
2. **Bubbles lift off the ground without shouting.** Both washes have a contrast of about 1.4 against the ground.
3. **The two bubbles weigh the same.** Their lightness is close (19 and 22), the text inside is the same ink, and its contrast is about 10 on both. Neither side of a conversation is louder.
4. **Warm colour is rationed.** The interface is cool. Warmth is kept for what you sent and for what has gone wrong.

## Colour

| Role | Variable | Value | Used for |
| --- | --- | --- | --- |
| Ground | `--ground` | `#172024` | chat background, inside the composer |
| Surface | `--surface` | `#202b30` | top bar, list, settings, composer area |
| Raised | `--raised` | `#263238` | grouped cards, form fields |
| Line | `--line` | `#36464d` | between layers |
| Strong line | `--line-strong` | `#4a5d65` | field outlines |
| Ink | `--ink` | `#e9eeee` | primary text |
| Soft ink | `--ink-soft` | `#aebcc2` | secondary text, times, notes |
| Accent | `--accent` | `#9acbbb` | anything that can be acted on, the live lamp |
| On accent | `--on-accent` | `#202b30` | text and icons on an accent fill |
| Verdigris wash | `--verdigris-wash` | `#253e36` | received messages, avatars |
| Copper wash | `--copper-wash` | `#44352d` | sent messages |
| Alarm | `--alarm` | `#f0ac95` | not sent, failed |
| Attention | `--attention` | `#d9b872` | waiting, worth a look |

## Rules

- **One accent.** Pale verdigris marks what can be pressed, and only that.
- **Bubbles are washes.** A low-saturation fill with ink text and no outline.
- **Depth without shadow.** Layers within a screen are told apart by a lightness step and a hairline. Shadow is for what sits over the screen: sheets, drawers, the update notice.
- **Colour is one cue among several.** Sent and received are also told by side, by the tail of the bubble and by a label. Every status has words.

## Type

- The interface is set in the system sans-serif. Serif is kept for the Estoc wordmark. DIDs and addresses are monospace.
- Two weights: 400 and 600. 600 is for names and titles.
- Four sizes: 12 for times and status, 15 for body, 16 for names and input, 22 for a screen title.
- Input text is at least 16, so that a phone browser does not zoom in on focus.

## Shape

- Three radii: 4 for the tail corner of a bubble, 12 for buttons and cards, 16 for bubbles. Avatars and the send button are round.
- A touch target is at least 44 by 44.
- A list row is at least 80 tall, with one line between rows.

## Screens

- A phone shows one screen at a time: list, then chat, then details. A wide window keeps the list beside the chat, with details at the side.
- The list is home. The avatar at the top left opens You and settings, the button at the top right starts a conversation, and the connection status sits under the title.
- The chat screen holds messages and the composer. What the protocol keeps is one step below details.
- A problem that blocks what the person is doing is shown on that screen. The full reason opens from there.

## Words

- Message status is reported as it is. Handed to the mediator, received by the other side, and not sent are three different things. Received does not mean read.
- What deleting, blocking, backing up and merging will do is said at the moment of the action.
