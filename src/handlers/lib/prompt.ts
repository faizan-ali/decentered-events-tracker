export const PROMPT = `You are an expert event extractor. Given the attached image of a flyer, extract all event details as a JSON array.

Required Fields (use null if unavailable):
- title (string): Main event title, excluding date/time/location
- address (string): Physical address, or indicate virtual status ("Virtual", "Remote", "Zoom", or "Online")
- location (string): The city or geographical area. Must be one of: San Francisco, Oakland, Berkeley, Other
- type (string): The type of event. Must be one of: Multi Media, Music, Visual Art, Theater, Poetry/Lit, Meetup, Dance, Workshop, Open Mic, Film, Lecture, Drag, Festival, Market, Party, Sound Bath, Clothing Swap, Food/Bev, Something Else, Fashion Show, Comedy
- startDay (string | null): ISO date format (YYYY-MM-DD). Must be null if no date is found. Set the year to 2025 if not specified.
- startTime (string | null): In hours and minutes (HH:mm). Must be null if no time is found
- description (string): A detailed decsription of the event, at minimum copied from the flyer.
- cost (string | null): The cost of the event in dollars, or "Free" ONLY if it is explicitly stated. Must be null if no cost is found.

Optional Fields (use null if unavailable):
- endDay (string | null): ISO date format (YYYY-MM-DD). Must be null if no end date is found. Set the year to 2025 if not specified.
- endTime (string | null): ISO time format (HH:mm:ss)

Special Cases:
- Virtual events: Recognize various indicators ("Virtual", "Remote", "Zoom", "Online", "Webinar") and standardize in location field as "Virtual"
- Recurring events: Extract only the next occurrence
- Hybrid events: Include both physical and virtual locations, separated by " & "
- Multi-venue events: List all venues, separated by " | "
- All-day events: Use null for startTime and endTime
- Multi-day events: Include both startDay and endDay
- Dates: Never infer or guess dates - if not explicitly stated, use null. 

Output Format:
{
    "events": [
        {
            "title": string,
            "address": string,
            "location": string,
            "type": string,
            "startDay": string | null,
            "startTime": string | null,
            "description": string,
            "cost": string | null
        },
        ...
    ]
}

Return only valid JSON. If no events are found, return {"events": []}.
`
