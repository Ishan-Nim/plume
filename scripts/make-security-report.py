# Builds the security audit report as a PDF.
import datetime
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer,
                                Table, TableStyle, KeepTogether)

OUT = r"E:\MD APP\docs\security\Plume-Security-Audit-2026-10-08.pdf"

INK      = colors.HexColor("#1d1d22")
MUTED    = colors.HexColor("#55555f")
FAINT    = colors.HexColor("#8b8b96")
ACCENT   = colors.HexColor("#6e56cf")
LINE     = colors.HexColor("#e4e4e9")
BAND     = colors.HexColor("#f6f6f9")
HIGH     = colors.HexColor("#c2410c")
MED      = colors.HexColor("#b45309")
LOW      = colors.HexColor("#0f766e")
OK       = colors.HexColor("#15803d")

ss = getSampleStyleSheet()
def S(name, **kw):
    base = kw.pop("parent", ss["Normal"])
    return ParagraphStyle(name, parent=base, **kw)

title    = S("t",  fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=INK, spaceAfter=2)
sub      = S("s",  fontName="Helvetica", fontSize=10.5, leading=15, textColor=MUTED)
h1       = S("h1", fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=INK, spaceBefore=16, spaceAfter=6)
h2       = S("h2", fontName="Helvetica-Bold", fontSize=11, leading=15, textColor=INK, spaceBefore=11, spaceAfter=3)
body     = S("b",  fontName="Helvetica", fontSize=9.6, leading=14.4, textColor=INK, alignment=TA_LEFT, spaceAfter=5)
small    = S("sm", fontName="Helvetica", fontSize=8.6, leading=12.6, textColor=MUTED, spaceAfter=4)
mono     = S("m",  fontName="Courier", fontSize=8.4, leading=12, textColor=INK,
             backColor=BAND, borderPadding=5, spaceBefore=3, spaceAfter=6)
cell     = S("c",  fontName="Helvetica", fontSize=8.8, leading=12.4, textColor=INK)
cellhead = S("ch", fontName="Helvetica-Bold", fontSize=8.8, leading=12.4, textColor=INK)

def page_furniture(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.setLineWidth(0.5)
    canvas.line(20*mm, 16*mm, 190*mm, 16*mm)
    canvas.setFont("Helvetica", 7.5); canvas.setFillColor(FAINT)
    canvas.drawString(20*mm, 11*mm, "Plume — security audit · 8 October 2026 · CONFIDENTIAL")
    canvas.drawRightString(190*mm, 11*mm, "Page %d" % doc.page)
    canvas.restoreState()

doc = BaseDocTemplate(OUT, pagesize=A4,
                      leftMargin=20*mm, rightMargin=20*mm, topMargin=18*mm, bottomMargin=22*mm,
                      title="Plume — Security Audit", author="CyberCrew", subject="Security audit of Plume 1.1.0")
doc.addPageTemplates([PageTemplate(id="main",
    frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="f")],
    onPage=page_furniture)])

def table(rows, widths, head=True, zebra=True):
    data = []
    for i, r in enumerate(rows):
        style = cellhead if (head and i == 0) else cell
        data.append([Paragraph(c, style) for c in r])
    t = Table(data, colWidths=widths, hAlign="LEFT")
    cmds = [
        ("VALIGN", (0,0), (-1,-1), "TOP"),
        ("LINEBELOW", (0,0), (-1,0), 0.7, LINE),
        ("TOPPADDING", (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING", (0,0), (-1,-1), 6),
        ("RIGHTPADDING", (0,0), (-1,-1), 6),
    ]
    if head:
        cmds.append(("BACKGROUND", (0,0), (-1,0), BAND))
    if zebra:
        for i in range(1, len(rows)):
            if i % 2 == 0:
                cmds.append(("BACKGROUND", (0,i), (-1,i), colors.HexColor("#fafafc")))
    cmds.append(("GRID", (0,0), (-1,-1), 0.3, LINE))
    t.setStyle(TableStyle(cmds))
    return t

def chip(text, colour):
    # reportlab wants a leading # on a hex colour inside markup.
    return '<font color="#%s"><b>%s</b></font>' % (colour.hexval()[2:], text)

story = []
A = story.append

# ---------------------------------------------------------------- cover
A(Paragraph("Security audit", title))
A(Paragraph("Plume 1.1.0 — desktop application, Plume Vault API, and plume-md.com", sub))
A(Spacer(1, 3))
A(Paragraph("8 October 2026 · static review and dynamic testing against production · CONFIDENTIAL", small))
A(Spacer(1, 10))

A(table([
    ["Scope", "Method", "Result"],
    ["Desktop app (Electron, main + renderer)", "Static review, dependency audit, live instrumentation", chip("No issues of consequence", OK)],
    ["Plume Vault API (api.plume-md.com)", "Static review, authenticated dynamic testing", chip("No issues of consequence", OK)],
    ["plume-md.com (static site)", "Static review, header and framing checks", chip("1 medium — host headers", MED)],
    ["Third-party libraries that ship", "npm audit, bundle inspection", chip("1 medium — fixed in this pass", MED)],
], [62*mm, 58*mm, 50*mm]))

A(Paragraph("Four issues were found; two were fixed during the audit and are already in production. "
            "Two remain and both require access to the hosting dashboard, which the auditor does not hold. "
            "No issue allowed one account to reach another's data, and none permitted unauthenticated access.", body))

# ---------------------------------------------------------------- summary
A(Paragraph("Findings at a glance", h1))
A(table([
    ["#", "Finding", "Severity", "Status"],
    ["1", "A KaTeX version with a published advisory was being shipped inside the application bundle", chip("Medium", MED), chip("Fixed", OK)],
    ["2", "The website serves no security headers; its sign-in page could be framed", chip("Medium", MED), chip("Partly mitigated", MED)],
    ["3", "Git identity values were passed to <font face='Courier'>git config</font> without a shape check", chip("Low", LOW), chip("Fixed", OK)],
    ["4", "Build tooling carries eight advisories; none reaches a user", chip("Informational", FAINT), chip("Accepted", FAINT)],
], [8*mm, 92*mm, 26*mm, 44*mm]))

# ---------------------------------------------------------------- findings
A(KeepTogether([
    Paragraph("Findings in detail", h1),
    Paragraph("1 — A vulnerable KaTeX was shipping inside the bundle &nbsp;&nbsp;" + chip("MEDIUM", MED) + " &nbsp;" + chip("FIXED", OK), h2),
    Paragraph("<b>What was wrong.</b> <font face='Courier'>npm audit --omit=dev</font> reported no vulnerabilities, which is misleading for this project: "
              "every runtime library is declared as a <i>devDependency</i> because esbuild bundles it into the renderer. They all ship. "
              "Inspecting the built bundle's notices showed <b>two copies of KaTeX</b> going out — 0.19.0 required directly, and <b>0.16.47</b> pulled in by Mermaid. "
              "The second falls inside GHSA-238p-pmpm-9mq7, in which prototype pollution can bypass KaTeX's <font face='Courier'>trust</font> option.", body),
    Paragraph("<b>Exploitability in context.</b> Reduced by three existing controls: Mermaid runs at <font face='Courier'>securityLevel: 'strict'</font>, "
              "rendered SVG passes through a cleaner that strips interactive and top-layer elements, and the renderer's "
              "<font face='Courier'>script-src 'self'</font> policy blocks <font face='Courier'>javascript:</font> URLs. "
              "No working exploit was demonstrated. The finding is that a library with a known advisory was reaching users at all.", body),
    Paragraph("<b>Fix applied.</b> A single resolution is now pinned for every consumer:", body),
    Paragraph('"overrides": { "katex": "^0.19.0" }', mono),
    Paragraph("The bundle now carries KaTeX 0.19.0 alone. Verified after the change by driving the real application: three KaTeX nodes "
              "and both Mermaid diagram types still render, with no console errors. No advisory now applies to any code that ships.", body),
]))

A(KeepTogether([
    Paragraph("2 — The website serves no security headers &nbsp;&nbsp;" + chip("MEDIUM", MED) + " &nbsp;" + chip("PARTLY MITIGATED", MED), h2),
    Paragraph("<b>What was wrong.</b> Responses from plume-md.com carry no <font face='Courier'>Strict-Transport-Security</font>, "
              "<font face='Courier'>Content-Security-Policy</font>, <font face='Courier'>X-Frame-Options</font>, "
              "<font face='Courier'>X-Content-Type-Options</font> or <font face='Courier'>Referrer-Policy</font>. "
              "The practical consequence is that <b>/app.html — which carries the sign-in form — can be placed in a frame on any site</b>, "
              "which is the precondition for a UI-redress attack. The absence of HSTS also leaves a first visit open to downgrade.", body),
    Paragraph("The API responses are better: they set <font face='Courier'>no-store</font>, <font face='Courier'>nosniff</font> and "
              "<font face='Courier'>no-referrer</font>, and CORS is a real allowlist — a foreign origin receives no "
              "<font face='Courier'>Access-Control-Allow-Origin</font> at all.", body),
    Paragraph("<b>What was done.</b> The site is static and served by the host, not by the API, so headers cannot be set from the "
              "repository; <font face='Courier'>frame-ancestors</font> is explicitly ignored in a meta tag. Each page now refuses to be "
              "framed from its own head script, before paint. This is a mitigation and not a substitute for the header.", body),
    Paragraph("<b>What remains for the owner.</b> Set these at DigitalOcean App Platform (or in a Cloudflare transform rule) for the static component:", body),
    Paragraph("Strict-Transport-Security: max-age=31536000; includeSubDomains<br/>"
              "X-Frame-Options: DENY<br/>"
              "X-Content-Type-Options: nosniff<br/>"
              "Referrer-Policy: strict-origin-when-cross-origin<br/>"
              "Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'", mono),
]))

A(KeepTogether([
    Paragraph("3 — Identity values reached <font face='Courier'>git config</font> unchecked &nbsp;&nbsp;" + chip("LOW", LOW) + " &nbsp;" + chip("FIXED", OK), h2),
    Paragraph("<b>What was wrong.</b> When Git sync initialises a repository it may set a commit identity derived from the signed-in vault account. "
              "<font face='Courier'>git config &lt;name&gt; &lt;value&gt;</font> treats a value beginning with a hyphen as an option and offers no "
              "<font face='Courier'>--</font> terminator, so a hostile address shape would have been read as a flag. The value originates from the "
              "server, which validates addresses, so this was defence in depth rather than a live path.", body),
    Paragraph("<b>Fix applied.</b> The address is shape-checked before git is handed it. Confirmed by test: "
              "<font face='Courier'>--global</font>, <font face='Courier'>-x@y.com</font> and <font face='Courier'>nonsense</font> are refused; "
              "an ordinary address is accepted.", body),
]))

A(KeepTogether([
    Paragraph("4 — Build-tooling advisories &nbsp;&nbsp;" + chip("INFORMATIONAL", FAINT) + " &nbsp;" + chip("ACCEPTED", FAINT), h2),
    Paragraph("Eight moderate advisories remain, all within electron-builder's dependency chain "
              "(<font face='Courier'>@electron/get</font>, <font face='Courier'>app-builder-lib</font>, "
              "<font face='Courier'>global-agent</font>, <font face='Courier'>roarr</font>, <font face='Courier'>sprintf-js</font> and siblings). "
              "None of this code is bundled into the application or executed on a user's machine; it runs only on the release builder. "
              "Recommended action is to track electron-builder updates rather than force a breaking downgrade.", body),
]))

# ---------------------------------------------------------------- what held
A(Paragraph("Controls tested that held", h1))
A(Paragraph("The following were exercised directly, most of them against the production service with two "
            "purpose-made accounts that were deleted afterwards.", small))

A(table([
    ["Control", "How it was tested", "Result"],
    ["Cross-account document access (BOLA/IDOR)", "Account A stored a document; account B requested it by the same path", chip("Refused — 404", OK)],
    ["Unauthenticated vault access", "Same request with no bearer token", chip("Refused — 401", OK)],
    ["Path traversal", "<font face='Courier'>../../etc/passwd</font>, encoded and doubled variants", chip("Refused — 400/404", OK)],
    ["Credential stuffing", "Twelve consecutive wrong passwords for one account", chip("Limited after 9", OK)],
    ["Reset flooding", "Eight consecutive reset requests", chip("Limited after 4", OK)],
    ["Contact-form abuse", "Twelve consecutive submissions", chip("All limited", OK)],
    ["Account enumeration", "Reset requested for a registered and an unregistered address", chip("Identical answers", OK)],
    ["Secret storage in a Git remote", "A remote containing <font face='Courier'>ghp_…</font> submitted to /git/status", chip("Token stripped", OK)],
    ["CORS policy", "Request bearing <font face='Courier'>Origin: https://evil.example</font>", chip("No ACAO returned", OK)],
    ["Mail-header injection", "Reply-To containing CRLF and a second recipient", chip("Refused", OK)],
    ["Electron process isolation", "Window preferences inspected in the running app", chip("Sandboxed, isolated", OK)],
    ["Navigation and window escape", "<font face='Courier'>will-navigate</font>, webview attachment, window open handler", chip("All prevented", OK)],
    ["Secrets in version control", "Pattern scan across tracked files in both repositories", chip("None found", OK)],
], [50*mm, 72*mm, 48*mm]))

# ---------------------------------------------------------------- notes
A(Paragraph("Observations, not findings", h1))
A(Paragraph("<b>Mail credentials are held in the application database.</b> They were placed there deliberately because the hosting "
            "environment was not reachable by the credential holder. This is defensible — anyone who can read that database already "
            "controls every account in it, and the Gmail grant is scoped to send only — but the environment remains the better home. "
            "Setting <font face='Courier'>GMAIL_*</font> on the application takes precedence automatically, after which the stored row "
            "can be removed with <font face='Courier'>scripts/set-mail-credentials.js --clear</font>.", body))
A(Paragraph("<b>Rate limiting is per-instance and held in memory.</b> The code states this assumption plainly. It is correct for a "
            "single instance, and was observed to behave consistently under test. Should the API ever be scaled horizontally, the "
            "limits weaken proportionally and should move to shared storage.", body))
A(Paragraph("<b>The application is not code-signed.</b> Windows SmartScreen and macOS Gatekeeper warn on first launch. Published "
            "checksums protect against a corrupted or substituted download but not against someone who controls the release itself. "
            "Signing remains the correct fix and is unchanged from previous releases.", body))
A(Paragraph("<b>Sign-up does not verify the address.</b> The code-based flow exists server-side but no shipped client speaks it yet, "
            "so <font face='Courier'>SIGNUP_REQUIRES_CODE</font> is off and accounts are created unverified. Enabling it before those "
            "clients ship would stop account creation entirely; this has happened twice already.", body))

# ---------------------------------------------------------------- method
A(Paragraph("Method and scope", h1))
A(Paragraph("<b>Static.</b> Manual review of the Electron main process, preload bridge and renderer; the vault API's routing, "
            "authentication, authorisation, storage and mail paths; and the website's scripts. Dependency analysis with "
            "<font face='Courier'>npm audit</font> on both projects, cross-checked against the built bundle's own notices, because "
            "the dependency manifest alone does not reveal what ships. Pattern scanning for credentials across all tracked files.", body))
A(Paragraph("<b>Dynamic.</b> Authenticated and unauthenticated testing against the production API, including cross-account access "
            "attempts, traversal, rate-limit exhaustion and injection of a credential-bearing Git remote. Transport and header "
            "inspection of the website. Instrumentation of the running desktop application through the Chrome DevTools Protocol to "
            "confirm process isolation and renderer behaviour.", body))
A(Paragraph("<b>Out of scope.</b> Infrastructure configuration at the hosting provider, the provider's own control plane, physical "
            "and social attack paths, and denial-of-service testing against production. No destructive testing was performed. Two "
            "accounts created for the authorisation tests were deleted; the five pre-existing accounts were untouched.", body))
A(Spacer(1, 6))
A(Paragraph("Prepared by CyberCrew. Findings 1 and 3 were remediated during the audit and the fixes are deployed. "
            "Finding 2 requires hosting-dashboard access to complete.", small))

doc.build(story)
print("written:", OUT)
