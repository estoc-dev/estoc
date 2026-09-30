# Estoc design language: copper and verdigris

Estoc has two looks, dark and light, and the dark one came first. This document holds the rules. The values live in the variables at the top of `app/src/style.css`; when the two disagree, fix whichever is wrong until they match.

The light look is derived from the relations below, not by brightening the dark swatches. It follows the system by default; either look can be chosen outright under You.

The selected light palette and its preview are saved in the [light palette proposal](light/README.md).

## In one line

On one cool ground, what arrives is verdigris and what you send is copper.

Verdigris is what copper turns into as it weathers. That reading came after the fact and is kept as a way to remember which colour is whose. The colours themselves were picked because they looked right.

## Relations

The relations between colours matter more than any single value. Change a colour only in a way that keeps all four true.

1. **Surfaces share one hue and differ in lightness.** Ground, surface, raised and line sit at hue 196 to 200. One layer up is one step lighter, in both looks: dark runs 12, 16, 18 and 26; light runs 91, 95, 98 and 76. The chat ground is therefore the darkest layer of the light look too, a cool grey rather than white, and cards sit near white on top of it.
2. **Bubbles lift off the ground without shouting.** A wash sits about eight steps of lightness from the ground. In the dark look that is a contrast of about 1.4; in the light look the same step gives about 1.3, because contrast is compressed at the light end. The step is the rule, the contrast is what it comes to.
3. **The two bubbles weigh the same.** Their lightness is close (19 and 22 dark, 78 and 80 light), the text inside is the same ink, and its contrast is about 10 on both. Neither side of a conversation is louder.
4. **Warm colour is rationed.** The interface is cool. Warmth is kept for what you sent, for what is still waiting and for what has gone wrong.

The two looks are not each other's negatives, but the dark ground and the light ink are one colour, and so are the dark surface and the light on-accent. Everything that is pale in the dark look (accent, alarm, attention) is deep in the light look, since it has to read as text on a light surface; it keeps a contrast of at least 4.5 on any surface it sits on, including the washes.

## Colour

| Role | Variable | Dark | Light | Used for |
| --- | --- | --- | --- | --- |
| Ground | `--ground` | `#172024` | `#e3ebee` | chat background, inside the composer |
| Surface | `--surface` | `#202b30` | `#eef3f5` | top bar, list, settings, composer area |
| Raised | `--raised` | `#263238` | `#f7fafb` | grouped cards, form fields |
| Line | `--line` | `#36464d` | `#b7c8ce` | between layers |
| Strong line | `--line-strong` | `#4a5d65` | `#93a9b1` | field outlines |
| Ink | `--ink` | `#e9eeee` | `#172024` | primary text |
| Soft ink | `--ink-soft` | `#aebcc2` | `#44565e` | secondary text, times, notes |
| Accent | `--accent` | `#9acbbb` | `#24634f` | actions, avatar letters, unread counts, the live state |
| On accent | `--on-accent` | `#202b30` | `#f7fafb` | text and icons on an accent fill |
| Verdigris wash | `--verdigris-wash` | `#253e36` | `#b9d6c9` | received messages, avatars |
| Copper wash | `--copper-wash` | `#44352d` | `#dfc8ba` | sent messages |
| Alarm | `--alarm` | `#f0ac95` | `#9a3619` | not sent, failed |
| Attention | `--attention` | `#d9b872` | `#7d5c12` | waiting, worth a look |
| Attention wash | `--attention-wash` | `#3a3226` | `#ebdcb8` | a bar that asks for a look |
| Scrim | `--scrim` | `#00000099` | `#17202466` | behind a sheet or drawer |
| Shadow | `--shadow` | `#00000088` | `#17202433` | under what sits over the screen |

## Rules

- **One accent.** Verdigris, pale on dark and deep on light, is the single accent. It marks actions, identity, unread counts and the live state, so it does not by itself say that something can be pressed.
- **Bubbles are washes.** A low-saturation fill with ink text and no outline.
- **Depth without shadow.** Layers within a screen are told apart by a lightness step and a hairline. Shadow is for what sits over the screen: sheets, drawers, the update notice. In the light look the steps between layers are small, so the hairline carries more of the work and is drawn a little heavier than a proportional scaling would give.
- **One set of rules, two values each.** Every colour is one variable written with `light-dark()`, so a screen never picks its look; the root's `color-scheme` does. The QR code keeps a white ground in both looks, since it is read by a camera, not a person.
- **Colour is one cue among several.** Sent and received are also told by side and by the tail of the bubble. Every status has words.

## Type

- The interface is set in the system sans-serif. Serif is kept for the Estoc wordmark. DIDs and addresses are monospace.
- The main weights are 400 and 600. 600 is for names and titles. The letter in an avatar is 500.
- The main sizes are 12 for times and status, 15 for body, 16 for names and input, and 22 for the title of the list. These are the ones to reach for first.
- Other sizes in use: 13 for notes, 14 for list previews and small buttons, 17 for the name at the top of a chat, 18 for the title of any other screen, 20 for a sheet title, 24 for the title of a first-run screen and the letter in a large avatar.
- Input text is at least 16, so that a phone browser does not zoom in on focus.

## Shape

- The main radii are 4 for the tail corner of a bubble, 12 for buttons and cards, and 16 for bubbles. Avatars, the send button and the unread count are round.
- Other radii in use: 8 for a block of monospace text, 10 for form fields and chips, 20 for sheets, 22 for the composer, 28 for the update notice.
- Where the pointer is a finger, an action is at least 44 by 44. With a mouse, small buttons and text-style actions may be smaller. A text-style action that stands on its own takes the full size and the room that goes with it, so that two targets do not cover one another. A link that is part of a sentence takes the size of its text.
- A list row is at least 80 tall, with one line between rows.

## Screens

- A phone shows one screen at a time: list, then chat, then details. A wide window keeps the list beside the chat, with details at the side.
- The list is home. The avatar at the top left opens You and settings, the button at the top right starts a conversation, and the connection status sits under the title.
- The chat screen holds messages and the composer. What the protocol keeps is one step below details.
- What is rarely done to a message, such as erasing its content, stays off the line under it, which carries only the message's status and what it asks to be done now. It remains available through a focusable, labelled control on every device, shown on hover where there is a mouse and otherwise out of sight until the keyboard or assistive technology reaches it. A press-and-hold or a right click on the bubble is a shortcut to the same place.
- A problem that blocks what the person is doing is shown on that screen. The full reason opens from there.

## Words

- Message status is reported as it is. Handed to the mediator, received by the other side, and not sent are three different things. Received does not mean read.
- What deleting, blocking, backing up and merging will do is said at the moment of the action.
