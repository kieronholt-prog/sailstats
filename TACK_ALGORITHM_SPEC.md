# TACK_ALGORITHM_SPEC.md — Implementation Instructions for Cursor

## Overview

Rewrite the SailStats analysis engine with a fundamentally improved approach to tack/gybe detection, wind direction estimation, and manoeuvre quality scoring. The current algorithm uses a fixed wind direction and simple COG threshold crossing. The new algorithm derives wind direction continuously from the sailing data itself, detects manoeuvres from track geometry without needing a wind input, scores tack quality based on exit performance rather than simple speed loss, and handles rapid tack sequences (tack groups) properly.

## Important Context

Read CLAUDE.md for the full project context. The analysis engine lives entirely in `index.html` within the `<script type="text/babel">` block. Key existing functions to replace: `estWind()`, `detectMans()`, `scoreMan()`, and `runAnalysis()`. The UI components and Strava/file parsing code should remain unchanged.

---

## PHASE 1: Stable Segment Detection

### Purpose
Identify periods where the boat is sailing a steady course at meaningful speed. These segments are the foundation for everything else.

### Algorithm

```
For each GPS point (enriched with smoothed SOG and COG):

1. Compute COG rate of change:
   cogRate[i] = absolute angular difference between COG[i] and COG[i-3] 
                divided by time difference (gives degrees/second)
   Use a 3-second lookback to smooth out GPS noise

2. Label each point as "stable" if:
   - cogRate < 4 degrees/second (boat not turning)
   - smoothed SOG > 1.5 knots (boat actually moving)
   Both conditions must hold

3. Group consecutive stable points into segments:
   - Minimum segment length: 5 seconds
   - Record for each segment:
     - startIndex, endIndex
     - startTime, endTime  
     - duration (seconds)
     - meanCOG (circular mean of all COG values in segment)
     - meanSOG (mean of smoothed SOG in knots)
     - cogStdDev (standard deviation of COG within segment)
   - Segments shorter than 5 seconds are discarded
     (they merge into the surrounding unstable/manoeuvre zone)
```

### Output
Array of stable segments: `[{startIdx, endIdx, startTime, endTime, duration, meanCOG, meanSOG, cogStdDev}, ...]`

### Notes on circular mean
COG values wrap around 360°. Use atan2(mean of sin values, mean of cos values) to compute the circular mean. Standard deviation should also use circular statistics.

```javascript
function circularMean(angles) {
  const sinSum = angles.reduce((s, a) => s + Math.sin(a * DEG), 0);
  const cosSum = angles.reduce((s, a) => s + Math.cos(a * DEG), 0);
  return ((Math.atan2(sinSum / angles.length, cosSum / angles.length) / DEG) + 360) % 360;
}
```

---

## PHASE 2: Manoeuvre Detection

### Purpose
Identify tacks and gybes from transitions between stable segments, without requiring a wind direction input.

### Algorithm

```
For each pair of adjacent stable segments (segBefore, segAfter):

1. Compute the angular difference:
   cogChange = absolute angular difference between segBefore.meanCOG 
               and segAfter.meanCOG

2. If cogChange > 50 degrees, this is a manoeuvre

3. Record:
   - type: "tack" or "gybe" (classified later in Phase 3)
   - index: midpoint between segBefore.endIdx and segAfter.startIdx
   - time: timestamp at that midpoint
   - preCOG: segBefore.meanCOG
   - postCOG: segAfter.meanCOG
   - cogChange: the angular difference
   - preSpeed: segBefore.meanSOG
   - preSegment: reference to segBefore
   - postSegment: reference to segAfter
   - gapDuration: time between segBefore.endTime and segAfter.startTime
     (this is the manoeuvre duration)

4. Apply the "look-around buffer":
   - The pre-tack REFERENCE speed and COG should come from the segment
     data EXCLUDING the last 5 seconds of segBefore
   - This avoids contamination from the sailor sitting up, looking 
     around, and slightly altering course before initiating the tack
   - If segBefore is shorter than 8 seconds, use all of it 
     (can't afford to trim a short segment)
   - Compute: preRefCOG = circular mean of segBefore points from 
     start to (end - 5 seconds)
   - Compute: preRefSpeed = mean SOG over same window
```

---

## PHASE 3: Tack Group Detection

### Purpose
Handle rapid tack sequences where there isn't enough stable sailing between tacks to establish independent references.

### Algorithm

```
1. Walk through the detected manoeuvres in chronological order

2. Start a new tack group whenever:
   - A manoeuvre's preSegment (segBefore) has duration < 8 seconds
     AND that segment is the postSegment of the previous manoeuvre
   - This means the gap between two tacks didn't have enough 
     stable sailing to be independent

3. A tack group contains:
   - groupManoeuvres: array of the individual manoeuvres in the group
   - preGroupSegment: the stable segment before the first manoeuvre 
     in the group (this is the group's entry reference)
   - postGroupSegment: the stable segment after the last manoeuvre
     in the group (this is the group's exit reference)
   - interSegments: the brief stable segments between the tacks 
     within the group (these still contain useful data)
   - totalDuration: time from first tack initiation to the point 
     where post-group speed and heading have stabilised

4. Solo manoeuvres (not part of a group) form a group of size 1 
   for uniform handling downstream
```

### Output
Array of tack groups: `[{manoeuvres: [...], preSegment, postSegment, interSegments: [...], isSolo: bool}, ...]`

---

## PHASE 4: Tack Angle Clustering and Wind Direction

### Purpose
Identify which tacks are genuine close-hauled upwind tacks versus reach-to-reach or tactical tacks. Use the high-confidence upwind tacks to derive wind direction.

### Algorithm

```
1. Collect all tack angles (cogChange) from solo manoeuvres and 
   group manoeuvres

2. Find the dominant tack angle cluster:
   - Compute the median tack angle
   - Mark tacks within ±15 degrees of the median as 
     "high confidence upwind"
   - Tacks outside this range are "tactical" or "reaching"
   - Require at least 3 high-confidence tacks to proceed
     (if fewer, fall back to using all tacks)

3. From high-confidence tacks, collect:
   - All preRefCOG values from starboard tack entries 
     → compute mean → meanStarboardCOG
   - All preRefCOG values from port tack entries 
     → compute mean → meanPortCOG
   - (Determine port vs starboard by which side of the 
     bisector the heading falls on — bootstrap with an initial 
     rough estimate from the COG histogram)

4. Compute base wind direction:
   - windDir = circular mean of (meanStarboardCOG, meanPortCOG)
   - This is the bisector of the average close-hauled headings
   - Choose the bisector that is on the upwind side 
     (the side the bows cross through during tacks, not gybes)

5. Compute average tack angle:
   - tackAngle = angular difference between meanStarboardCOG 
     and meanPortCOG
   - This is the fleet/sailor's typical tack angle for this session

6. Now classify each manoeuvre as tack or gybe:
   - If the COG change crosses through the upwind side of the 
     wind direction → tack
   - If the COG change crosses through the downwind side → gybe
```

### Bootstrapping port vs starboard
Before you have a wind direction, you can use this heuristic: take the two most common COG clusters from all stable segments (the same histogram approach currently used). The two dominant clusters are approximately port and starboard close-hauled headings. Their bisector gives an initial wind estimate to seed the classification.

---

## PHASE 5: Continuous Wind Trace

### Purpose
Track the true wind direction throughout the race using close-hauled segment data, providing a wind shift timeline.

### Algorithm

```
1. For every stable segment classified as close-hauled 
   (segment meanCOG within 10 degrees of either meanStarboardCOG 
    or meanPortCOG from Phase 4):

   - Determine if port or starboard based on which mean it's 
     closer to
   - Estimate wind at this moment:
     - If starboard: windEst = segment.meanCOG + (tackAngle / 2)
     - If port: windEst = segment.meanCOG - (tackAngle / 2)
   - Assign this windEst to the timestamp at the midpoint 
     of the segment

2. For inter-tack segments within tack groups:
   - Even brief 3-4 second segments can contribute a wind estimate
   - Use the same calculation but flag these as lower confidence

3. Create the wind trace timeline:
   - Array of {time, windDir, confidence} points
   - confidence = "high" for segments > 10 seconds, 
     "medium" for 5-10 seconds, "low" for < 5 seconds

4. Smooth the wind trace:
   - Apply a 30-second rolling weighted average 
     (weighted by segment duration/confidence)
   - This filters out the sailor's small course adjustments 
     (wave hunting, trim changes, traffic avoidance)
   - The smoothed trace represents genuine wind shifts

5. During non-upwind legs (reaches, runs):
   - No close-hauled data available
   - Interpolate linearly between the last upwind wind estimate 
     and the next upwind wind estimate
   - Flag these interpolated sections as "estimated" 
     (shown as dotted line in the chart)

6. Compute wind shift metrics:
   - Total wind range (max - min) during the race
   - Average shift period (time between direction changes)
   - Shift trend (persistent veer/back or oscillating)
```

### Output
```javascript
windTrace: [{time, windDir, confidence, interpolated}, ...]
windStats: {range, avgShiftPeriod, trend}
```

---

## PHASE 6: Performance Baselines

### Purpose
Establish the sailor's own performance targets from their data in this session. These targets are what tack exits are measured against.

### Algorithm

```
1. From all high-confidence close-hauled stable segments:

   Port tack baseline:
   - targetPortCOG: circular mean of all port segment COGs
   - targetPortSpeed: mean SOG across all port segments 
     (weighted by segment duration)

   Starboard tack baseline:
   - targetStbdCOG: circular mean of all starboard segment COGs
   - targetStbdSpeed: mean SOG across all starboard segments 
     (weighted by segment duration)

2. These baselines can optionally be computed with a time window 
   (rolling baseline) to account for changing conditions, but for 
   V1 a session-wide baseline is sufficient.

3. Also compute:
   - Overall upwind VMG baseline (for cost calculations)
   - Speed percentiles (to identify what "fast" and "slow" 
     mean for this sailor in these conditions)
```

---

## PHASE 7: Tack Exit Quality Scoring

### Purpose
Score each tack (and tack group) based on how quickly and effectively the sailor exits onto the new tack at target speed and heading.

### Algorithm for solo tacks

```
1. Identify the target heading and speed for the post-tack side:
   - If tacking to port: target = targetPortCOG, targetPortSpeed
   - If tacking to starboard: target = targetStbdCOG, targetStbdSpeed

2. Starting from the tack point (midpoint of the manoeuvre gap), 
   scan forward through the GPS data:

   Speed recovery time:
   - Find the first point where SOG >= 90% of target speed
   - Time from tack point to this moment = speedRecoveryTime
   - If never reached within 30 seconds, cap at 30

   Heading convergence time:
   - Find the first point where COG is within 5 degrees of 
     target heading AND stays within 5 degrees for at least 
     3 consecutive seconds (to avoid counting a momentary 
     pass-through)
   - Time from tack point to this moment = headingConvergenceTime

   Exit characterisation:
   - In the first 5 seconds after the tack, is the COG above 
     (higher/closer to wind) or below (lower/further from wind) 
     the target heading?
   - If above: sailor exited high (pinching) — common error, 
     slow to accelerate
   - If below: sailor exited low (footing) — builds speed faster 
     but loses height initially
   - Record: exitBias = "high" | "low" | "neutral" 
     (within 3 degrees = neutral)
   - Record: exitBiasAmount = average degrees above/below target 
     in first 5 seconds

3. Speed profile:
   - Record speed at each second from 10 seconds before to 
     25 seconds after the tack point
   - This creates the mini chart sparkline for each tack

4. VMG cost:
   - Compute the pre-tack VMG (using pre-reference speed and 
     heading against LOCAL wind direction from the wind trace 
     at this moment, not the global wind)
   - For each second from tack initiation to speed recovery, 
     compute the actual VMG
   - VMG cost in metres = integral of (preVMG - actualVMG) 
     over recovery period, converted from knots·seconds to metres
   - vmgCostMetres = sum of ((preVMG_ms - actualVMG_ms) * dt) 
     for each second during recovery

5. Quality score (0-100):
   - speedScore = max(0, 100 - speedRecoveryTime * 6)
     (0 seconds = 100, 16+ seconds = 0)
   - headingScore = max(0, 100 - headingConvergenceTime * 5)
     (0 seconds = 100, 20+ seconds = 0)  
   - vmgScore = max(0, 100 - vmgCostMetres * 2)
     (0m cost = 100, 50+ metres = 0)
   - quality = round(speedScore * 0.3 + headingScore * 0.35 + vmgScore * 0.35)
```

### Algorithm for tack groups

```
1. Pre-group reference: from preGroupSegment 
   (excluding last 5 seconds for look-around buffer)

2. Post-group reference: from postGroupSegment

3. Group speed recovery: time from first tack in group to 
   reaching 90% of target speed on the final tack's side

4. Group heading convergence: time from last tack in group 
   to heading settling within 5 degrees of target

5. Group VMG cost: integral of VMG deficit across the entire 
   group duration (from first tack to full recovery)

6. Group quality score: same formula as solo tacks but using 
   group-level metrics

7. Inter-tack analysis within the group:
   - For each brief segment between tacks in the group, record:
     - duration
     - meanCOG (contributes to wind estimate)
     - meanSOG (shows if speed was building between tacks)
     - implied wind direction
   - This data is shown in the tack group detail view

8. Individual tacks within the group still get recorded with:
   - Their exit COG and speed from whatever data exists
   - But they do NOT get individual quality scores
   - The group score is what represents performance
```

---

## PHASE 8: Tack Classification

### Purpose
Classify each tack as reactive (tacked on a header), proactive (tacked in anticipation of a shift), or tactical (tacked for strategic/traffic reasons).

### Algorithm

```
1. Get the smoothed wind trace value at the tack time

2. Compare the wind trace trend over the 30 seconds before the tack:
   - windDelta = windTrace(tackTime) - windTrace(tackTime - 30s)
   - This shows if the wind was shifting

3. Determine if the shift was a header for this tack:
   - If on starboard and wind shifted LEFT (backed): header
   - If on port and wind shifted RIGHT (veered): header
   - If on starboard and wind shifted RIGHT (veered): lift
   - If on port and wind shifted LEFT (backed): lift

4. Classify:
   
   REACTIVE (tacked on a header):
   - Wind shifted to head the sailor by > 3 degrees in the 
     30 seconds before the tack
   - The pre-tack COG shows gradual divergence from the 
     running average for that tack
   
   PROACTIVE (anticipated a shift):
   - Wind shift < 3 degrees before the tack (shift hadn't 
     arrived yet)
   - BUT the post-tack heading is notably better than the 
     running average for the new tack (> 5 degrees lifted)
   - The shift arrived during or after the tack
   
   TACTICAL (strategic reasons):
   - No significant wind shift before or after
   - Likely tacking for layline, traffic, or other strategic reason
   - This is the default classification if neither reactive 
     nor proactive criteria are met

5. Confidence level:
   - High: clear wind shift > 5 degrees correlating with tack
   - Medium: moderate shift 3-5 degrees
   - Low: ambiguous or insufficient data
```

---

## PHASE 9: Charts Specification

### Speed Over Time Chart (existing, enhanced)

```
- X axis: elapsed time from activity start
- Y axis: speed in knots
- Primary line: smoothed SOG (teal/accent colour)
- Area fill: gradient below the speed line
- Vertical markers: thin vertical lines at each tack (orange) 
  and gybe (cyan) with small labels "T1", "T2", "G1" etc.
- Background segments: alternating subtle background shading to 
  indicate leg types:
  - Upwind legs: very subtle blue tint
  - Downwind legs: very subtle amber tint
  - Reaching legs: no tint (default background)
  - Leg labels at the top of each segment ("↑ Up", "↓ Down", "→ Reach")
```

### Wind Direction Chart (NEW — sits directly below speed chart)

```
- X axis: same elapsed time axis as speed chart, aligned exactly
- Y axis: wind direction in degrees (scale auto-fits to range 
  of wind ± 20 degrees padding)
- Primary line: smoothed wind trace (solid line during upwind 
  legs, DOTTED line during non-upwind legs where wind is 
  interpolated/estimated)
- Shading: subtle band showing ± the standard deviation of 
  wind estimates at each point (confidence band)
- Colour: warm colour (amber/gold) for the wind line
- Reference line: thin horizontal dashed line at the session 
  mean wind direction
- Vertical markers: same tack/gybe markers as speed chart, 
  aligned vertically so you can see the correlation between 
  wind shifts and tack decisions
- Background segments: same leg-type shading as speed chart
- Non-upwind periods: dotted line connecting last known wind 
  estimate to next known estimate, with a text note 
  "wind estimated" in muted colour
- Annotation: at each tack point, a small arrow or marker showing 
  the shift direction (▲ for veering, ▼ for backing)
```

### Chart Alignment

```
- Both charts must share the same X axis and be vertically stacked 
  with no gap between them
- The speed chart sits on top, the wind chart below
- Leg-type background segments span both charts vertically
- Tack/gybe vertical markers span both charts
- This creates an integrated view where the sailor can see:
  "my speed dropped here (top chart) because the wind shifted 
  here (bottom chart) and I tacked here (vertical line)"
- Use a shared time axis component or ensure both charts use 
  identical X domains and tick spacing
- Total height: speed chart ~180px, wind chart ~120px
```

### Leg Segmentation Visual

```
- The background shading for leg types should be very subtle:
  - Upwind: rgba(74, 158, 255, 0.06) — barely visible blue
  - Downwind: rgba(255, 184, 74, 0.06) — barely visible amber
  - Reach: transparent
- A thin top border at each leg transition
- Small leg type label at the top of each segment
- If course marks are defined, show mark names at leg transitions
  (e.g. "Castle → Coronation")
```

---

## PHASE 10: Integration into runAnalysis()

### Updated function signature
```javascript
function runAnalysis(rawPts, userWind = null, markPos = null, laps = 1)
```

`userWind` is now optional — if provided, it overrides the auto-detected wind as a starting point but the continuous wind trace still runs. If null, wind is fully auto-detected.

### Updated return object
```javascript
{
  points: [...],              // enriched GPS points
  
  // Wind
  windDir: number,            // session mean wind direction
  windEst: {dir, conf},       // auto-detection result
  windTrace: [{time, windDir, confidence, interpolated}, ...],
  windStats: {range, avgShiftPeriod, trend},
  
  // Segments
  stableSegments: [...],      // all stable sailing segments
  
  // Performance baselines
  baselines: {
    portCOG, portSpeed,
    stbdCOG, stbdSpeed,
    tackAngle,
    upwindVMG
  },
  
  // Manoeuvres
  tackGroups: [{
    manoeuvres: [...],
    preSegment, postSegment, interSegments,
    isSolo: bool,
    quality: number,
    speedRecovery: number,
    headingConvergence: number,
    vmgCost: number,
    exitBias: string,
    classification: string,    // "reactive" | "proactive" | "tactical"
    classificationConfidence: string,
    speedProfile: [{t, speed}, ...],
    windAtTack: number,
    windShiftBefore: number,
  }, ...],
  
  // Summary stats (kept for backward compatibility)
  stats: {
    totalDist, duration, maxSpeed, avgSpeed,
    tackCount, gybeCount,
    avgTackQuality, avgGybeQuality,
    reactiveTacks, proactiveTacks, tacticalTacks,
    windShiftRange, portStbdSplit
  },
  
  // Legs (unchanged from current implementation)
  legs: [...],
  
  // Speed data (unchanged)
  streaks: {...},
  speedTL: [...],
  portS, stbdS,
}
```

---

## PHASE 11: UI Updates

### Overview tab
- Replace the existing speed timeline chart with the new stacked 
  speed + wind chart
- Add wind shift summary stats (range, trend)
- Update tack/gybe counts to include classification breakdown
  (e.g. "12 tacks: 7 reactive, 3 proactive, 2 tactical")

### Manoeuvres tab
- Group display: show tack groups with their overall score
- Solo tack display: show individual score with exit bias indicator
  ("exited 6° high" or "exited 3° low")
- Classification badge on each tack ("header", "anticipated", "tactical")
- The speed profile sparkline for each tack should now also show 
  target speed as a thin horizontal reference line
- For tack groups: show expanded view with the inter-tack data,
  wind estimates during the group, and individual tack markers

### Speed tab
- No changes needed — existing speed distribution and polar 
  charts are fine

### Legs tab
- No changes needed — existing leg breakdown is fine

---

## Implementation Order

Implement in this order, testing each phase works before moving on:

1. **Stable segment detection** — verify by logging segments and 
   checking they make sense against a known GPS track
2. **Manoeuvre detection** — verify tack count matches what you'd 
   expect from a known race
3. **Tack group detection** — verify rapid tack sequences are 
   grouped correctly
4. **Wind direction derivation** — verify the computed wind direction 
   is reasonable for a known race where you remember the conditions
5. **Continuous wind trace** — verify the trace shows sensible 
   shifts and is smooth during upwind legs, dotted during reaches
6. **Performance baselines** — verify port/starboard targets look right
7. **Tack exit scoring** — verify scores correlate with what 
   you'd subjectively call good and bad tacks
8. **Tack classification** — verify reactive tacks actually had 
   headers before them
9. **Stacked charts** — build the aligned speed + wind charts 
   with leg segmentation
10. **UI integration** — wire everything into the existing tabs

## Testing Approach

Use a GPX file from a known WSC Wednesday evening race where you 
remember the conditions. Check:
- Does the auto-detected wind direction match your memory?
- Does the tack count match what you think you did?
- Are the "good" tacks (the ones you remember going well) scoring 
  higher than the "bad" ones?
- Does the wind trace show shifts you remember experiencing?
- Are tack groups detected where you know you did rapid tacks?

If any of these don't match, adjust the thresholds (stable segment 
minimum duration, COG rate threshold, tack angle clustering range) 
before moving on.
