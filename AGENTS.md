# KZQ Project Instructions

## Project purpose

KZQ is a responsive product showcase and inquiry website for a building
materials company.

The same frontend serves two different usage environments:

- Mobile: a WeChat-friendly H5 experience that should feel similar to a
  lightweight mini-program.
- Desktop: a formal international B2B company website and product catalog.

The frontend must work for both Chinese domestic visitors and overseas buyers.

## Current task priority

The current priority is upgrading the public-facing frontend to a premium
black-and-gold visual system.

The approved visual direction is:

- premium industrial minimalism
- graphite black and charcoal backgrounds
- restrained warm-gold accents
- warm off-white content surfaces
- large material and interior photography
- strong visual hierarchy
- credible B2B manufacturing presentation
- mobile mini-program-like interaction
- desktop corporate website presentation

The reference design is a visual direction, not a source of business facts.

## Scope boundaries

Unless explicitly requested, only modify the public-facing frontend:

- app/(public)
- components/public
- shared UI components used by the public site
- public-facing styles and design tokens

Do not modify the following unless absolutely necessary:

- Supabase schemas or migrations
- authentication
- RLS policies
- inquiry API behavior
- admin CMS behavior
- database types
- deployment configuration
- SEO structured data logic

Preserve existing routes, CMS fields, product data, category data, inquiry
behavior, localization behavior and Demo mode.

Do not replace dynamic CMS data with hardcoded display data.

## Business content restrictions

Do not copy business claims, certifications, statistics, addresses, phone
numbers or product specifications from a visual reference.

Only display information that already exists in the repository data or CMS.

Do not introduce unconfirmed claims such as:

- ISO 9001
- CARB P2
- A1 or B1 fire rating
- solid wood claims
- invented export-country counts
- invented production capacity
- invented certificates
- invented customer numbers

Existing confirmed product rules must remain unchanged:

- fire rating: B级
- environmental rating: E0级
- pricing: contact sales for quotation
- certificates: display or watermarked versions only

## Design tokens

Use a restrained black-and-gold system.

Recommended base colors:

- page black: #0D0F10
- graphite: #141719
- elevated graphite: #1D2023
- warm gold: #C5A15A
- light gold: #D9BD82
- warm white: #F4F1EA
- soft white: #FAF8F3
- body text: #25282B
- muted text: #8D9093
- dark border: rgba(255,255,255,0.10)
- light border: rgba(20,23,25,0.10)

Gold must be used selectively for:

- primary CTA
- active navigation state
- important numeric highlights
- small dividers and accents
- focus states

Do not use large flat areas of bright gold.

Do not use pure black for every surface. Create depth through graphite layers.

## Typography

Use a clean, professional typography hierarchy.

- English hero headings may use a refined display or editorial style.
- Chinese body text must remain highly readable.
- Do not load fonts from a runtime third-party CDN.
- Prefer next/font or reliable system font fallbacks.
- Do not sacrifice performance for typography.

## Desktop behavior

At desktop widths:

- use a formal top navigation
- use a wide cinematic hero
- present products like a professional B2B catalog
- use generous whitespace
- create clear sections for categories, products, company strength,
  certificates and inquiry
- use a content width around 1200–1440px
- avoid excessive floating cards and excessive rounded corners
- product imagery should have strong visual priority

## Mobile behavior

At mobile widths:

- do not merely shrink the desktop layout
- create a WeChat H5 / mini-program-like experience
- use a compact mobile header
- keep a fixed bottom navigation
- use thumb-friendly touch targets
- provide a clear inquiry entry
- use compact category grids
- allow horizontal product browsing only where appropriate
- respect safe-area insets
- avoid content being covered by the fixed bottom navigation
- optimize for widths from 360px to 430px

## Components

Prefer reusable components and design primitives.

Create or refine components such as:

- public site header
- mobile header
- desktop navigation
- hero section
- section heading
- category card
- product card
- trust item
- certificate card
- inquiry CTA
- mobile bottom navigation
- public footer

Avoid creating one very large page component.

Avoid duplicating desktop and mobile business logic. Responsive presentation may
differ, but both should consume the same underlying data.

## Images

Use next/image where appropriate.

Preserve image aspect ratios and avoid layout shift.

Use existing repository assets and CMS images. Do not introduce remote image
dependencies merely to imitate the reference design.

Use gradients and overlays to keep hero text readable.

## Motion

Motion must be subtle and optional.

Allowed:

- short hover transitions
- restrained image zoom
- button state transitions
- subtle reveal effects

Avoid:

- heavy animation libraries
- autoplay effects that harm performance
- excessive parallax
- motion that prevents immediate interaction

Respect prefers-reduced-motion.

## Accessibility

Maintain:

- semantic HTML
- keyboard navigation
- visible focus states
- sufficient text contrast
- accessible buttons and links
- meaningful image alt text
- minimum practical mobile touch targets

Do not use gold text on white backgrounds where contrast is insufficient.

## Performance

Do not add a production dependency unless it is clearly justified.

Prefer CSS and existing dependencies.

Avoid:

- large animation frameworks
- unnecessary client components
- unnecessary JavaScript state
- huge unoptimized images
- runtime calls to external font or image CDNs

## Validation requirements

After frontend changes, run:

- npm run typecheck
- npm run lint
- npm run build

Test at minimum:

- 360px mobile
- 390px mobile
- 430px mobile
- 768px tablet
- 1024px desktop
- 1440px desktop

Verify:

- no horizontal overflow
- no fixed-navigation overlap
- no broken links
- no missing loading or empty states
- no hardcoded fake content
- no regression in inquiry behavior
- no regression in CMS-driven content
- no regression in Demo mode

When browser or screenshot tools are available, capture at least:

- 390 × 844 mobile screenshot
- 1440 × 1000 desktop screenshot

Compare screenshots against the provided design reference before declaring the
task complete.

## Working method

Before editing:

1. inspect the existing implementation
2. identify reusable components
3. identify data and business logic that must remain untouched
4. provide a concise implementation plan

Then implement the requested scope.

At completion, report:

- files changed
- components added or refactored
- important design decisions
- validation commands and results
- remaining visual differences from the reference
