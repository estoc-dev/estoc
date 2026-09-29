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
4. **Warm colour is rationed.** The interface is cool. Warmth is kept for what you sent, for what is still waiting and for what has gone wrong.

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
| Accent | `--accent` | `#9acbbb` | actions, avatar letters, unread counts, the live state |
| On accent | `--on-accent` | `#202b30` | text and icons on an accent fill |
| Verdigris wash | `--verdigris-wash` | `#253e36` | received messages, avatars |
| Copper wash | `--copper-wash` | `#44352d` | sent messages |
| Alarm | `--alarm` | `#f0ac95` | not sent, failed |
| Attention | `--attention` | `#d9b872` | waiting, worth a look |

## Rules

- **One accent.** Pale verdigris is the single accent. It marks actions, identity, unread counts and the live state, so it does not by itself say that something can be pressed.
- **Bubbles are washes.** A low-saturation fill with ink text and no outline.
- **Depth without shadow.** Layers within a screen are told apart by a lightness step and a hairline. Shadow is for what sits over the screen: sheets, drawers, the update notice.
- **Colour is one cue among several.** Sent and received are also told by side and by the tail of the bubble. Every status has words.

## Type

- The interface is set in the system sans-serif. Serif is kept for the Estoc wordmark. DIDs and addresses are monospace.
- The main weights are 400 and 600. 600 is for names and titles. The letter in an avatar is 500.
- The main sizes are 12 for times and status, 15 for body, 16 for names and input, and 22 for the title of the list. These are the ones to reach for first.
- Other sizes in use: 13 for notes and eyebrows, 14 for list previews and small buttons, 17 for the name at the top of a chat, 18 for the title of any other screen, 20 for a sheet title, 24 for the title of a first-run screen and the letter in a large avatar.
- Input text is at least 16, so that a phone browser does not zoom in on focus.

## Shape

- The main radii are 4 for the tail corner of a bubble, 12 for buttons and cards, and 16 for bubbles. Avatars, the send button and the unread count are round.
- Other radii in use: 8 for a block of monospace text, 10 for form fields and chips, 20 for sheets, 22 for the composer, 28 for the update notice.
- Where the pointer is a finger, an action is at least 44 by 44. With a mouse, small buttons and the actions under a message may be smaller. A link inside a sentence takes the size of its text.
- A list row is at least 80 tall, with one line between rows.

## Screens

- A phone shows one screen at a time: list, then chat, then details. A wide window keeps the list beside the chat, with details at the side.
- The list is home. The avatar at the top left opens You and settings, the button at the top right starts a conversation, and the connection status sits under the title.
- The chat screen holds messages and the composer. What the protocol keeps is one step below details.
- A problem that blocks what the person is doing is shown on that screen. The full reason opens from there.

## Words

- Message status is reported as it is. Handed to the mediator, received by the other side, and not sent are three different things. Received does not mean read.
- What deleting, blocking, backing up and merging will do is said at the moment of the action.
