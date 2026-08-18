// The BotFather walkthrough, shown wherever a bot token can be pasted.
export function BotSteps() {
  return (
    <ol className="bot-steps">
      <li>
        Open Telegram and search for <code>@BotFather</code> — Telegram's
        official bot maker, marked with a blue tick.
      </li>
      <li>
        Send it the command <code>/newbot</code>.
      </li>
      <li>Give your bot a name. Any name works — it is just what the chat is called.</li>
      <li>
        Choose a unique username for it. This one must end in{" "}
        <code>bot</code> — something like <code>my_jarvis_bot</code>.
      </li>
      <li>
        BotFather replies with a token that looks like{" "}
        <code>1234567890:AbCd…</code> — paste it below. Jarvis keeps it on
        this Mac and nowhere else.
      </li>
    </ol>
  );
}
