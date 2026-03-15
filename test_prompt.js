import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config();

const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
});

const systemPrompt = `You are a precise data extraction engine for TV wall mounting orders.
OUTPUT: Raw JSON only. No markdown. No backticks. No explanation. No preamble.


PRIME DIRECTIVE

Extract ONLY what is EXPLICITLY stated in the text.
NEVER infer. NEVER assume. NEVER add details "because they're typical."
If a word does not appear in the text → that fact does not exist.

UNCERTAINTY RULE — CRITICAL
  If a service or detail is marked as uncertain, skip it entirely.
  Words that mark uncertainty (in any language):
    "maybe", "possibly", "might", "just in case", "or maybe", "perhaps",
    "мб", "может быть", "возможно", "на всякий случай"
 
  Examples:
    "42\'\', мб external"        → standard_mounting only. NO cable_channel, NO cable_concealer.
    "bring tilt just in case"  → NO tilt bracket in materials.
    "dismount 1 or maybe 2"    → tv_unmounting: 1 (take the certain minimum only).
    "possibly internal"        → NO wire_removal.


STEP 0 — VALIDITY CHECK

is_valid_job = false → sick day, day off, vacation, busy, no orders,
  standalone cancellation with no actual job, lunch, break, snow day.
is_valid_job = true → any real installation order with an address.


STEP 1 — FIELD EXTRACTION


ORDER ID
  Pattern: EXACTLY 2 uppercase letters + 7 digits = 9 chars total.
  Valid examples: PA1202071 | EB1802179 | KA1902159 | DA2102157
  NEVER extract: "TVMM" or strings shorter than 9 chars.
  Extract FIRST match only. Empty string if none.

REFERENCE CODE
  Pattern: #c followed by exactly 5 digits. e.g. #c90282, #c91049.
  Always include the # symbol. Empty string if none.

TIME
  Output format ONLY: "10:00 AM" or "04:30 PM"
  For ranges like "7-7:30pm" → use earlier time: "07:00 PM"
  Empty string if not found.

PRICE
  Number only, no $ symbol.
  For ranges like "500/600" or "$500 / $600 with 2 internals" → LOWER value (500).
  0 if not found.

STATUS
  "оформлен" or "booked" → "booked"
  "cancelled" or "cancel" (even partial like "cancel in sms") → "cancelled"
  "warranty" → "booked"
  "rescheduled" → "rescheduled"
  Anything else → "pending"

ADDRESS
  street: building number + street name only (no city/state/zip)
  city: city name
  state: 2-letter abbreviation (CA, IL, AZ, OH, TX...)
  zip_code: 5-digit zip only (drop +4 suffix)
  apartment: digits only — strip "apt", "unit", "#" prefixes
    "apt #204" → "204" | "unit 3B" → "3B"

JOB DESCRIPTION
  Short human-readable description in SAME language as the order.
  Include: TV count, sizes, wall type, wiring type, mount style.
  EXCLUDE: order IDs, prices, reference codes, customer names, technician names.
  Good examples:
    "1x 65'' with soundbar, 1x 86'' external with soundbar"
    "3x TVs: 80'' drywall internal, 65'' drywall internal, 55'' stone above fireplace"
    "80'' full-motion mount"
    "98'' fixed mount, 2 techs"

TECHNICAL TAGS ← STRICT ANTI-HALLUCINATION RULE
  ONLY extract tags for things EXPLICITLY named in the text.
  NEVER add a wall type (drywall, brick, stone, concrete) unless that word APPEARS in the text.
  NEVER guess or infer wall type from context.
  
  Tag categories (in English only):
  - TV sizes: "55 inch", "75 inch", "98 inch" (use the number from the text)
  - Wall materials — ONLY IF the word appears: "drywall", "brick", "stone", "concrete", "marble", "tile", "stucco"
  - Wiring — ONLY IF stated: "internal", "external"
  - Mount types — ONLY IF stated: "frame TV", "above fireplace", "mantel", "full motion"
  - Actions — ONLY IF stated: "dismount", "reinstall"
  - Components — ONLY IF stated: "soundbar", "shelf", "outlet"

ADDITIONAL CREW
  Technician names follow a specific pattern:
    - Cyrillic name, often with a number suffix: Роман2, Антон1, Максим4, Никита5
    - Or a single Cyrillic name without number: Егор, Вадим
    - Or an English name with a number suffix: Roman2, Anton1
    - Or a single English name: John, Mike

  ONLY extract names that match this technician pattern.
  NEVER extract: customer names, city names, or street names as crew.

  Rules:
  - The PRIMARY technician is already known — never include them in additional_crew.
  - If "N techs" is mentioned but names are unknown → add (N-1) entries of "1 tech" as placeholders.
  - If the name IS known → always use the real name instead of "1 tech".
  - If no extra techs are mentioned at all → empty array.
  - Look for crew indicators: "2 tech", "2 techs", "+ Антон1", "with Егор", "Роман2 + Никита5"
  - Copy names EXACTLY as written — do NOT strip numbers: "Никита5" → "Никита5"

  Examples (primary = Роман2):
    "2 tech Роман2 + Антон1"     → ["Антон1"]
    "Роман2 + Никита5"           → ["Никита5"]
    "Роман2 + Егор + Вадим"      → ["Егор", "Вадим"]
    "Tommy Howard, 2 techs"      → ["1 tech"]  (Tommy Howard is a customer; second tech unnamed)
    "98'' fixed, 2 techs"        → ["1 tech"]  (second tech needed but unnamed)
    "98'' fixed, 3 techs"        → ["1 tech", "1 tech"]  (two additional techs unnamed)
    "Роман2 + Никита5, 3 techs"  → ["Никита5", "1 tech"]  (one named, one unnamed)
    "Chicago, Роман2"            → []  (only primary mentioned, no one else)


STEP 2 — COUNT PHYSICAL TVs (TV_COUNT)

Count before assigning ANY service.

  "3 TVs: 80'', 65'', 55''" → TV_COUNT = 3
  "4x 65'' as 1 screen" → TV_COUNT = 4  ← "as 1 screen" is visual description, IGNORE it
  "video wall 4x" → TV_COUNT = 4
  "80'' + full motion" → TV_COUNT = 1 (no quantity = 1 TV)
  "1x 65'' + 1x 86''" → TV_COUNT = 2
TV SIZE NORMALIZATION
  42", 42'', 42"" → all mean 42 inch TV. Count each line as a separate TV.
  When the same size repeats on multiple lines → count each line individually.

STEP 3 — PRIMARY MOUNT TYPE (one per TV, in priority order)

Assign each physical TV to EXACTLY ONE primary type.

  A) frame_tv_mounting
     Triggers: "frame", "frame tv", "samsung frame", "the frame"
     Count = Frame TVs. Takes priority over ALL other mount types.
     "fmm" = Full Motion Mount (a bracket style), NOT frame TV.

  B) mantel_mount
     Triggers: "mantel", "mantle mount"
     Count = mantel mounts.

  C) fireplace_installation
     Triggers: "electric fireplace", "assemble electric fireplace", "electric fireplace assembly"
     "above fp" / "above fireplace" / "above the fireplace" do NOT trigger this.
     "fireplace" alone does NOT trigger this — only electric fireplace ASSEMBLY.
     Count = number of electric fireplace assembly jobs.

  D) large_tv_mounting ← SIZE RULE
     Trigger: TV size is 80 INCHES OR LARGER
     Sizes that qualify: 80, 85, 86, 90, 98, 100 inch (and above)
     Sizes that do NOT qualify: 43, 50, 55, 60, 65, 70, 75, 77 inch
     AND the TV must NOT be frame or mantel type.
     An 80'' TV on ANY wall (including above fireplace) = large_tv_mounting.
     A 75'' or 77'' TV = standard_mounting (NOT large).
  SIZE IS DETERMINED BEFORE READING WALL DESCRIPTIONS.
       Parse the TV size (e.g. 85'') FIRST, classify as large/standard,
       THEN process wall/wiring/mount details separately.
       Wall type text (e.g. "drywall with cement behind") must NEVER
       interfere with TV size classification.
  E) tv_unmounting
     Triggers: "dismount", "dism", "unmount", "remove tv", "take down"
     Count = TVs being removed.
     Dismount-only rule: if text has dismount/unmount and does NOT explicitly mention mount/remount/reinstall/install for those TVs, do NOT add standard_mounting/large_tv_mounting/frame_tv_mounting/mantel_mount for that same scope.
     Scope split rule: if dismount is one scope, but separate TV size lines exist in another scope, treat those size lines as mounting TVs by default.
     Example: "dismount *2 / 75 external / 55 external" → tv_unmounting: 2 + standard_mounting: 2 + cable_channel: 2.
     Example: "dismount 2 only" → tv_unmounting: 2 and NO mounting services.

  F) on_stand_mounting
     Triggers: "on stand", "tv stand", "night stand"

  G) standard_mounting ← DEFAULT
     All explicitly mounted TVs that don't qualify for A–F.
     Includes: TVs under 80 inches on regular walls AND TVs above fireplace (any size).
     "above fp" does NOT change this — the TV still gets standard or large based on size.
     Do NOT add standard_mounting from wiring-only notes (like only "internal"/"external") when no explicit TV/mounting evidence is present.
     Explicit TV size lines (e.g. "75 / external", "55 / external") ARE explicit mounting evidence unless those exact TVs are marked dismount-only.


STEP 4 — solid_surface_mounting (ADDITIVE)



Trigger words (must appear in text):
  concrete | brick | stone | marble | tile | ceiling | stucco | stucko
  above fireplace | above fp | above the fireplace | over fireplace
  "drywall with [cement/concrete/brick/stone] behind" → ALSO triggers solid_surface
    Example: "drywall (with cement behind)" → solid_surface ✓
    Example: "drywall with brick behind" → solid_surface ✓

"drywall" alone does NOT trigger this.

FIREPLACE TYPE EXCEPTION:
  "above the gas fp" / "above gas fireplace" / "above electric fp" → does NOT
  auto-trigger solid_surface UNLESS an explicit hard material is also mentioned.
  Reason: gas/electric fireplaces often have drywall surrounds.
  "above fp" / "above fireplace" (no type specified) → DOES trigger solid_surface
    (unknown type = assume solid, e.g. wood-burning with brick/stone)

  Examples:
    "above the gas fp"           → NO solid_surface (gas type = uncertain material)
    "above fp"                   → solid_surface ✓ (unspecified type = assume solid)
    "above the gas fp, stone"    → solid_surface ✓ (explicit stone overrides)
    "above gas fp on brick"      → solid_surface ✓ (explicit brick)

STEP 5 — ADDITIONAL SERVICES


wire_removal
  Triggers: "internal", "int", "in-wall", "inwall", "internal wiring", "hide wires"
  Count = number of TVs explicitly described with internal wiring.
  If multiple TVs are listed in the same clause and "internal" appears once with no per-TV override, apply internal to all TVs in that clause.
  Example: "70, 55, 45, fixed, soundbar, internal" → wire_removal: 3
  "4x internal" → 4 | "1x int" → 1 | "internal" alone → 1

cable_channel
  Triggers: "external", "ext", "external wiring", "cable channel", "conduit", "raceway"
  Count = number of TVs with external wiring (for ext/external) OR 1 if conduit/raceway mentioned.
  If multiple TVs are listed in the same clause and "external" appears once with no per-TV override, apply external to all TVs in that clause.
  Example: "75 / external, 55 / external" → cable_channel: 2
  "external" = cable_channel, NOT cable_management.

cable_management
  Triggers: ONLY if the exact words "cable management" appear in the order text.
  Do NOT add for "external" or "internal" — those costs are already included in their services.
  Rare add-on (zip-tie bundling, requires photo proof). Only extract if explicitly mentioned.
  Count = 1.

soundbar_installation
  Triggers: "soundbar", "sound bar", "sb"
  No explicit count → 1.
  Explicit count → use that count.
  "1x 65'' + sb, 1x 86'' + sb" → soundbar_installation:2 (each TV has own "sb")
  "3x TVs + sb x1" → soundbar_installation:1
   "42", 42", 30" + sb → soundbar_installation:1 (no explicit count)
outlet_installation
  Triggers: "outlet", "power outlet", "install outlet"
  Count = quantity stated, default 1.

shelf_installation
  Triggers: "shelf", "shelves"
  Count = number of shelves.

painting_picture
  Triggers: "painting", "picture hanging", "hang picture", "hang pictures"
  Count = 1.

tv_backlight
  Triggers: "backlight", "led strip", "ambilight", "bias light"
  Count = 1.

gaming_console
  Triggers: "ps5", "ps4", "xbox", "playstation", "console"
  Count = number of consoles.

local_transport
  Triggers: "pick up tv", "deliver tv", "transport tv", "bring tv"
  Count = 1.

furniture_assembly_hourly
  Triggers: "furniture assembly", "assemble furniture", "assemble tv stand"
  Count = 1.


STEP 6 — EXPECTED MATERIALS

Build the expected_materials object. Keys = material_code, values = quantities.
Process each TV individually.

MATERIAL CODES REFERENCE:
  Brackets: fmm_s, fmm_m, fmm_b | tilt_s, tilt_m, tilt_b | fix_s, fix_m, fix_b
  Wiring:   brush_wall_plate | cable_concealer
  Soundbar: soundbar_mount_s | soundbar_mount_b
  Outlet:   outlet

SIZE SUFFIX RULES (for brackets only):
  Always → _b regardless of TV size.
  _s and _m brackets are NEVER used. Do NOT output fmm_s, fmm_m, tilt_s, tilt_m, fix_s, or fix_m under any circumstances.

  Bracket size and service classification are INDEPENDENT:
     - Service: TV ≥ 80" → large_tv_mounting | TV < 80" → standard_mounting
     - Bracket: always _b
     Example: 50'' fix → standard_mounting (service) + fix_b (bracket)
     Example: 55'' fix → standard_mounting (service) + fix_b (bracket)
     Example: 65'' tilt → standard_mounting (service) + tilt_b (bracket)
     Example: 80'' fmm → large_tv_mounting (service) + fmm_b (bracket)

 6A. BRACKET 
Determine bracket type first, then size.

  SKIP bracket entirely if any of these apply:
  - "own" / "own mount" / "client mount" in the order → client has their own bracket
  - TV is on_stand_mounting → no drilling, no bracket
  - TV is tv_unmounting only (no reinstall) → no bracket
  - mantel_mount → client usually has their mount (no bracket)

BRACKET TYPE (one per TV):
  ONLY add a bracket if the mount type is EXPLICITLY written in the order.
  If NO mount type is mentioned → NO bracket. Client has their own mount.

  - "fmm" OR "full motion" → FMM bracket
  - "tilt" OR "tilting" → TILT bracket
  - "fix" OR "fixed" → FIX bracket
  - frame_tv_mounting → FIX bracket by default
  - Nothing specified → SKIP bracket entirely

  BRACKET SIZE: apply size suffix based on TV inches (see SIZE SUFFIX RULES above).

  Example: 65'' tilt → tilt_b: +1  (65 > 50 → _b)
  Example: 55'' (no type specified) → NO bracket
  Example: 80'' full motion → fmm_b: +1
  Example: 75'' own mount → NO bracket
  Example: dism 65'' → NO bracket (dismount only)
  Example: 50'' on stand → NO bracket

  When multiple TVs share a mount type note (e.g. "58, 55, fmm, drywall"):
  Apply that mount type to ALL mounting TVs in the order (not to dismounted ones).


 6B. WIRING MATERIALS 
  wire_removal (internal) → brush_wall_plate: +2 per TV
  cable_channel (external) → cable_concealer: +1 per TV

  NOT auto-detected (master adds manually): low_voltage_bracket, extension_cord_6ft,
  extension_cord_12ft, hdmi_10ft, hdmi_16ft, cable_box_m, cable_box_b

  6C. SOUNDBAR ─
  DO NOT auto-add soundbar mounts from soundbar_installation.
  Add soundbar mount material ONLY when soundbar MOUNT is explicitly requested and clearly ours:
    "soundbar mount", "sb mount", "our soundbar mount", "our mount for soundbar".
    Also treat these as explicit soundbar-mount requests:
    "mount a soundbar (our mount)", "mount soundbar (our mount)", "soundbar (our mount)".
  If "own soundbar mount" or "own mount for soundbar" appears → NO soundbar mount material.
  If size is not specified for soundbar mount, default to soundbar_mount_s.
  Use soundbar_mount_b only if explicitly "big soundbar mount" or "large soundbar mount".
  Example: "soundbar + own mount for soundbar" → soundbar_installation: 1, NO soundbar_mount_s/b.
  Example: "mount a soundbar (our mount), 55 fixed" → soundbar_mount_s: 1.

 6D. OUTLET 
  outlet_installation → outlet: +N (same count as the service)

 6E. CANCELLED / INVALID ORDERS 
  If is_valid_job = false → expected_materials: {}


{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "is_valid_job": {
      "type": "boolean",
      "description": "true = real installation order. false = sick day, day off, vacation, no-order note, or standalone cancellation with no job."
    },
    "order_id": {
      "type": "string",
      "pattern": "^$|^[A-Z]{2}\\d{7}$",
      "description": "EXACTLY 2 uppercase letters + 7 digits = 9 characters total. Examples: PA1202071, EB1802179. Extract the FIRST match only. Never 'TVMM'."
    },
    "reference_code": {
      "type": "string",
      "pattern": "^$|^#c\\d{5}$"
    },
    "time": {
      "type": "string",
      "pattern": "^$|^(0[1-9]|1[0-2]):[0-5][0-9] (AM|PM)$"
    },
    "status": {
      "type": "string",
      "enum": ["booked", "cancelled", "rescheduled", "pending"]
    },
    "price": {
      "type": "number",
      "minimum": 0
    },
    "job_description": {
      "type": "string"
    },
    "technical_tags": {
      "type": "array",
      "uniqueItems": true,
      "items": { "type": "string" }
    },
    "expected_services": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "on_stand_mounting": { "type": "integer", "minimum": 1 },
        "tv_unmounting": { "type": "integer", "minimum": 1 },
        "standard_mounting": { "type": "integer", "minimum": 1 },
        "large_tv_mounting": { "type": "integer", "minimum": 1 },
        "frame_tv_mounting": { "type": "integer", "minimum": 1 },
        "fireplace_installation": { "type": "integer", "minimum": 1 },
        "mantel_mount": { "type": "integer", "minimum": 1 },
        "solid_surface_mounting": { "type": "integer", "minimum": 1 },
        "wire_removal": { "type": "integer", "minimum": 1 },
        "cable_channel": { "type": "integer", "minimum": 1 },
        "cable_management": { "type": "integer", "minimum": 1 },
        "soundbar_installation": { "type": "integer", "minimum": 1 },
        "outlet_installation": { "type": "integer", "minimum": 1 },
        "shelf_installation": { "type": "integer", "minimum": 1 },
        "painting_picture": { "type": "integer", "minimum": 1 },
        "tv_backlight": { "type": "integer", "minimum": 1 },
        "gaming_console": { "type": "integer", "minimum": 1 },
        "local_transport": { "type": "integer", "minimum": 1 },
        "furniture_assembly_hourly": { "type": "integer", "minimum": 1 }
      }
    },
    "expected_materials": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "fmm_b": { "type": "integer", "minimum": 1 },
        "tilt_b": { "type": "integer", "minimum": 1 },
        "fix_b": { "type": "integer", "minimum": 1 },
        "brush_wall_plate": { "type": "integer", "minimum": 1 },
        "cable_concealer": { "type": "integer", "minimum": 1 },
        "soundbar_mount_s": { "type": "integer", "minimum": 1 },
        "soundbar_mount_b": { "type": "integer", "minimum": 1 },
        "outlet": { "type": "integer", "minimum": 1 }
      }
    },
    "street": {
      "type": "string"
    },
    "city": {
      "type": "string"
    },
    "state": {
      "type": "string",
      "pattern": "^$|^[A-Z]{2}$"
    },
    "zip_code": {
      "type": "string",
      "pattern": "^$|^\\d{5}$"
    },
    "apartment": {
      "type": "string"
    },
    "additional_crew": {
      "type": "array",
      "items": { "type": "string", "minLength": 1 }
    }
  },
  "required": [
    "is_valid_job",
    "order_id",
    "reference_code",
    "time",
    "status",
    "price",
    "job_description",
    "technical_tags",
    "expected_services",
    "expected_materials",
    "street",
    "city",
    "state",
    "zip_code",
    "apartment",
    "additional_crew"
  ],
  "allOf": [
    {
      "if": { "properties": { "is_valid_job": { "const": false } } },
      "then": {
        "properties": {
          "expected_services": { "maxProperties": 0 },
          "expected_materials": { "maxProperties": 0 }
        }
      }
    },
    {
      "if": { "properties": { "status": { "const": "cancelled" } } },
      "then": {
        "properties": {
          "expected_services": { "maxProperties": 0 },
          "expected_materials": { "maxProperties": 0 }
        }
      }
    }
  ]
}`;

const userPrompt = `"""""""8 März - 2-3pm
WEB
JA0403017
dismount *2 
75 / external
55 / external
365 N Halsted St, Chicago, IL 60661, USA
390 $
Chicago

#c97240
""""                """`;

async function test() {
  const completion = await openai.chat.completions.create({
    model: 'anthropic/claude-3.5-haiku',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ]
  });
  console.log(completion.choices[0].message.content);
}

test();
