import type { Metadata } from "next";

import { JudgeGuide } from "@/components/judge/JudgeGuide";

/**
 * Unlisted judge guide. A static segment, so it wins over `[...route]` and does
 * not mount KitApp. Nothing in the app links here and search engines are told
 * not to index it; there is deliberately no robots.txt line, which would
 * publish the path.
 */
export const metadata: Metadata = {
  title: "4lpha · Judge guide",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <JudgeGuide />;
}
