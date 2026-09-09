# Context

The ubiquitous language of movie_club_v2. Glossary only — no schema, no
implementation, no decisions. Decisions live in `docs/adr/`.

## Movie

A film. The **canonical catalog**: one entry per film, ever. Every other
concept in the domain refers to a Movie rather than restating it — nothing
anywhere else carries a film's title, year, or poster.

A Movie is not "a film the club watched". The catalog may hold films the club
has never shown, and holds only facts about the film itself. Club data hangs
off the Session, not the Movie.

## Session

One month of the club: a Theme and the two Movies shown under it. The Session
is the unit the club actually organises around — months, not films, are what
get planned, announced, and met about.

A Movie may appear in more than one Session; the club can rewatch a film.

Whether a Session is upcoming, current, or past is **derived from the
calendar**, never stored — a Session does not carry a status, and nothing
marks one Session as "the current one". There is at most one Session per
month, which is what makes that derivation unambiguous.

Historically every Session has had exactly two Movies. The two are
**siblings** — neither is the headline film — though they carry a stable
order so they don't shuffle between page loads.

A Session is what v1 called a *monthly event*. That name is retired.

## Theme

The idea tying a Session's Movies together — _Difficult Moms_, _Aotearoa_,
_Heist_. A Theme belongs to a Session, never to a Movie. A Session may be
scheduled before its Theme is chosen.

## Meeting

When the club gathers to discuss a Session, and where. Distinct from the
Session's month: the meeting for a month often falls outside it. The meeting
is an announcement, not what decides which Session the site is showing.

## Member

One of the twelve people in the club. Every Member is a person who logs in;
there is no such thing as a Member who exists only as a name on old Ratings.

A Member is identified by identity, never by display name — renaming a Member
must not disturb their Ratings.

## Admin

The Member who curates — the one who admits people to the club and owns the
calendar. Admin is a *capacity a Member has*, not a separate kind of person:
an Admin is a Member who also rates films, and the club has always had one.

An Admin does not stand above the club's record. They may remove a Rating, but
never change one — a score belongs to the Member who gave it.

Distinct from v1's "admin login", which was a password in the page source that
gated a form and nothing else.

## Rating

One Member's score for one Movie, from 0 to 5, revisable. A Rating attaches to
the Movie rather than to a particular showing: rewatching a film does not give
a Member a second score for it.

A Rating remembers **when it was first given**, which does not move when the
score is revised. That is what makes "the Movies rated in August" a stable
question.

Scores are not whole numbers or half-steps — the club uses arbitrary decimals,
and a 4.99 is a deliberate act.

## Rating Unit

The club's playful name for the unit a Movie is scored in — "stars" replaced
by something apropos to the film. Flavour, not structure: it changes what a
score is *called*, never what it *means*. Used inconsistently, and kept
anyway. The one piece of club flavour that lives on the Movie.

In v1 this was called `rating_scale`, which was a misnomer — it never varied
the scale — and was quietly reused as a fallback Theme. Both stop.

## Impromptu

**Retired.** In v1 a Movie was labelled *official* or *impromptu*. This never
described how the club watched a film — it existed only so a Member could
rate something outside that month's Session. It is a presentation concern,
not a property of a Movie or of a Session, and v2 carries no such label.

The capability it stood in for survives: the Movies rated in a given month,
with the Session's Movies distinguishable among them. That is a question the
model answers, not a column.

## Motif

**Retired.** In v1 each Movie also carried a concrete object linking it to its
sibling (_Eggs_ for `Boy`, _Yellow Cab_ for `Goodbye Pork Pie`). Carried no
real value and rendered poorly; it does not survive into v2. Named here only
so the term isn't reintroduced by someone reading v1.
