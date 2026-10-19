/**
 * Ready-made layouts. Applying one creates a layout plus a small playlist for each zone
 * (world clock, news, YouTube), and can send it straight to screens and groups.
 *
 * main:        your own content (an existing playlist, or a new empty one to fill)
 * clock:       world clock
 * news-ticker: scrolling headlines
 * news-list:   headline list that pages through
 * youtube:     a YouTube video, playlist or live stream
 */
export type ZoneFill = "main" | "clock" | "news-ticker" | "news-list" | "youtube";

export interface Template {
  id: string;
  name: string;
  description: string;
  zones: { name: string; x: number; y: number; w: number; h: number; fill: ZoneFill }[];
}

export const TEMPLATES: Template[] = [
  {
    id: "news-clock",
    name: "News & world clock",
    description: "Your content, a world clock down the side and a news ticker along the bottom.",
    zones: [
      { name: "Main", x: 0, y: 0, w: 75, h: 88, fill: "main" },
      { name: "World clock", x: 75, y: 0, w: 25, h: 88, fill: "clock" },
      { name: "News ticker", x: 0, y: 88, w: 100, h: 12, fill: "news-ticker" },
    ],
  },
  {
    id: "youtube-news",
    name: "YouTube + news ticker",
    description: "A YouTube video or live stream with a news ticker underneath.",
    zones: [
      { name: "YouTube", x: 0, y: 0, w: 100, h: 88, fill: "youtube" },
      { name: "News ticker", x: 0, y: 88, w: 100, h: 12, fill: "news-ticker" },
    ],
  },
  {
    id: "newsroom",
    name: "Newsroom",
    description: "Headlines on the left, YouTube top right and world clocks below it.",
    zones: [
      { name: "Headlines", x: 0, y: 0, w: 38, h: 100, fill: "news-list" },
      { name: "YouTube", x: 38, y: 0, w: 62, h: 72, fill: "youtube" },
      { name: "World clock", x: 38, y: 72, w: 62, h: 28, fill: "clock" },
    ],
  },
  {
    id: "lobby",
    name: "Lobby",
    description: "Your content, with YouTube and a world clock stacked on the right.",
    zones: [
      { name: "Main", x: 0, y: 0, w: 70, h: 100, fill: "main" },
      { name: "YouTube", x: 70, y: 0, w: 30, h: 50, fill: "youtube" },
      { name: "World clock", x: 70, y: 50, w: 30, h: 50, fill: "clock" },
    ],
  },
  {
    id: "welcome",
    name: "Welcome screen",
    description: "Your content full width, with a clock and a news ticker in the bottom bar.",
    zones: [
      { name: "Main", x: 0, y: 0, w: 100, h: 86, fill: "main" },
      { name: "Clock", x: 0, y: 86, w: 22, h: 14, fill: "clock" },
      { name: "News ticker", x: 22, y: 86, w: 78, h: 14, fill: "news-ticker" },
    ],
  },
  {
    id: "clock-wall",
    name: "World clock wall",
    description: "Big clocks for several cities, filling the screen.",
    zones: [{ name: "World clock", x: 0, y: 0, w: 100, h: 100, fill: "clock" }],
  },
  {
    id: "news-wall",
    name: "News wall",
    description: "Full-screen headlines with a clock in the corner bar.",
    zones: [
      { name: "Headlines", x: 0, y: 0, w: 100, h: 86, fill: "news-list" },
      { name: "Clock", x: 0, y: 86, w: 100, h: 14, fill: "clock" },
    ],
  },
];
