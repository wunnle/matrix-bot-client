# Construct Actionable Notifications

Construct renders `[[Label]]` tokens in a message body as tappable action buttons. Sending the same message to a non-Construct client (Element, Cinny, FluffyChat, …) shows the raw bracketed text, which is ugly — so bots must detect the capability before using this syntax.

## Capability detection

Every outgoing message from Construct carries:

```json
{
  "msgtype": "m.text",
  "body": "…",
  "com.construct.capabilities": ["actionable"]
}
```

Before replying, read the triggering event's content:

```js
const caps = event.getContent()['com.construct.capabilities'] ?? []
const canActionable = Array.isArray(caps) && caps.includes('actionable')
```

Only emit `[[Label]]` tokens when `canActionable` is true. Otherwise phrase options as prose or a numbered list.

## Syntax

- The client parses every `[[...]]` token with the regex `/\[\[([^\]]{1,40})\]\]/g`.
- Each match becomes a button, in the order it appears.
- The bracketed tokens are **stripped** from the rendered prose, so leading text reads cleanly.
- Labels must be 1–40 characters and cannot contain `]`.

### Example

Bot sends:

```
Ready to book the flight? [[Confirm]] [[Cancel]] [[Remind me later]]
```

Construct renders:

> Ready to book the flight?
>
> [ Confirm ] [ Cancel ] [ Remind me later ]

When a user taps a button, Construct sends the label back as a plain message — no special routing needed.

## Style rules

- **2–4 buttons** per message. More than 4 wraps awkwardly.
- **Short labels.** 1–3 words on mobile; 40 chars is the hard ceiling.
- **Primary action first.** Users scan left-to-right.
- **Don't repeat the prompt in the label.** `[[Book it]]` beats `[[Yes, book it]]`.

## Fallback

If `canActionable` is false:

```
Ready to book the flight? Reply "confirm", "cancel", or "remind me later".
```

Handle both reply styles identically so the conversation works in any client.
