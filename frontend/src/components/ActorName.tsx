// A bot marker shown next to a bot actor's name wherever it is displayed.
export function BotTag() {
  return <span className="bot-tag" title="bot" aria-label="bot">🤖</span>;
}

// Renders an actor's display name, appending a bot marker when the actor is a bot.
export function ActorName({ name, bot }: { name: string; bot?: boolean }) {
  return (
    <>
      {name}
      {bot ? <> <BotTag /></> : null}
    </>
  );
}
