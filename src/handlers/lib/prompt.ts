export const PROMPT = `Extract ALL events from this image. The image may be a flyer, poster, social media post, screenshot, or any format containing event information.

CRITICAL: If the image lists multiple events (e.g. a workshop series, a lineup, a calendar), extract EVERY event as a separate entry. Do not summarize or collapse them.

For each event, return these fields:

- title (string): Event name only, no dates/times/locations
- address (string): Physical address or venue name. For virtual events use "Virtual"
- location (string): One of: San Francisco, Oakland, Berkeley, Other
- type (string): One of: Multi Media, Music, Visual Art, Theater, Poetry/Lit, Meetup, Dance, Workshop, Open Mic, Film, Lecture, Drag, Festival, Market, Party, Sound Bath, Clothing Swap, Food/Bev, Something Else, Fashion Show, Comedy
- startDay (string | null): YYYY-MM-DD format. Assume year 2026 if not specified. null if no date found
- endDay (string | null): YYYY-MM-DD format. Assume year 2026 if not specified. null if no end date found
- startTime (string | null): HH:mm 24-hour format. null if no time found
- endTime (string | null): HH:mm 24-hour format. null if no end time found
- description (string): A description specific to this individual event. Include relevant details from the image but tailor it to this specific event
- cost (string | null): Dollar amount or "Free" ONLY if explicitly stated. null if not mentioned

Rules:
- Never infer or guess dates. If not explicitly stated, use null
- Hybrid events: combine locations with " & "
- Multi-venue events: separate with " | "
- All-day events: null for startTime and endTime
- Multi-day events: set both startDay and endDay
- Recurring events with no distinct titles (e.g. "Every Tuesday at 7pm"): extract only the next occurrence
- A series of events with distinct names or dates: extract ALL of them individually

Return valid JSON:
{
    "events": [
        {
            "title": string,
            "address": string,
            "location": string,
            "type": string,
            "startDay": string | null,
            "endDay": string | null,
            "startTime": string | null,
            "endTime": string | null,
            "description": string,
            "cost": string | null
        }
    ]
}

If no events are found, return {"events": []}.
`
