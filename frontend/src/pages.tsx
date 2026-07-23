import type { ReactNode } from "react";

/**
 * The heading and standing description of each page.
 *
 * Shared between a page and the skeleton that stands in for it while its code and data are on the
 * way, for two reasons: the two cannot drift out of agreement, and the heading is a constant of the
 * page rather than of its data — so there is no reason for it to arrive with the data.
 */
export interface PageMeta {
  title: string;
  description: ReactNode;
}

export const PAGE_META = {
  labels: {
    title: "Labels",
    description:
      "Reusable tags an issue can carry any number of. Each has a name, an optional description, and a colour.",
  },
  graph: {
    title: "Graph",
    description: "Every issue you can see, drawn as the graph its dependencies and parents form.",
  },
  repos: {
    title: "Repositories",
    description: "The repositories attached to issues, and what each one depends on.",
  },
  notifications: {
    title: "Notifications",
    description:
      "Activity on the issues you're involved in. Marking one done clears it from your queue.",
  },
  tokens: {
    title: "API tokens",
    description: (
      <>
        Bots and scripts authenticate by sending <code>Authorization: Bearer &lt;token&gt;</code>. A
        token acts as you. Only a hash is stored — if you lose one, revoke it and create another.
      </>
    ),
  },
  admin: {
    title: "Admin",
    description:
      "Who can sign in, which groups they belong to, and bringing issues in from elsewhere.",
  },
} satisfies Record<string, PageMeta>;
