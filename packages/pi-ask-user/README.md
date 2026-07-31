# pi-tian-ask-user

Let the model ask you a multiple-choice question from [pi](https://pi.dev).

```bash
pi install npm:pi-tian-ask-user
```

Registers an `ask_user` tool. The model can supply 1–5 questions with 2–5
options each. Questions and option descriptions wrap across as many lines as
needed instead of being truncated. Every question also gets a free-form
**Other** option, and questions can allow either one or multiple selections.
A model-supplied Other-style option is refused rather than shown twice: the
duplicate would otherwise reach the user with nothing reporting it back.

Interactive controls:

- `←` / `→` — switch questions while preserving answers
- `↑` / `↓` — move between options
- `Space` — select an option or toggle it in a multi-select question
- `Enter` — move to the next question or submit the completed form
- `Esc` — go back from the custom-answer editor or dismiss the form

The public schema uses `questions[]`. Calls saved by versions through 0.1.2 with
top-level `question` and `options` are upgraded automatically when resumed.

While it waits for your answer, the tool reports the input requirement on pi's
**shared event bus** (`pi.events`). This is pi's in-process mechanism for tool ↔
integration communication: an integration subscribes with `pi.events.on(...)`,
aggregates active requests into its own agent state, and bridges that state to
its client.

The canonical event is `agent:input_required`. Its versioned payload has a
stable `id` so consumers can handle duplicate and concurrent requests safely:

```ts
{
  version: 1,
  id: string,        // ask_user tool-call ID
  source: "ask_user",
  active: boolean,   // true before waiting, false in finally
  label: string      // normalized question, always present
}
```

The same payload is temporarily also emitted as `herdr:blocked` for compatibility
with version 6 of [Herdr](https://herdr.dev)'s shipped pi integration. New
consumers should subscribe to `agent:input_required`; the producer reports why
it is waiting, while clients such as Herdr own final status precedence and
notification behavior.

Pi core has no native "blocked" status (only *working* while a tool call is in
flight vs *idle*), and can't distinguish an autonomous long-running tool from
one waiting on a human. Emitting is best-effort, balanced active→inactive via
`try/finally`, and a harmless no-op when nothing listens. No event is emitted in
non-UI modes.

See the [collection repository](https://github.com/TianZuo555/pi-tian-extensions#ask-user)
for full documentation.
