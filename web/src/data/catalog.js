/**
 * Static, display-only catalog data that the API does not provide:
 * instructors, ratings, prices, images, outcomes, reviews and topics.
 * Keyed by the course ids in data/seed/courses.json. Pure mock data.
 */

export const INSTRUCTORS = {
  priya: {
    id: 'priya',
    name: 'Priya Raman',
    headline: 'Lead Data Analyst and SQL trainer',
    photo: '/images/instructors/priya-raman.jpg',
    rating: 4.7,
    reviews: 48210,
    students: 312480,
    courses: 2,
    bio: 'Priya has spent eleven years turning messy business questions into clear answers with SQL and Python. She has led analytics teams in retail and fintech and has taught more than 300,000 learners how to query data with confidence.',
  },
  daniel: {
    id: 'daniel',
    name: 'Daniel Okafor',
    headline: 'Information designer, former newsroom graphics editor',
    photo: '/images/instructors/daniel-okafor.jpg',
    rating: 4.8,
    reviews: 15934,
    students: 98112,
    courses: 1,
    bio: 'Daniel built interactive charts for a national newsroom for eight years before moving into product analytics. He teaches the principles that make a chart honest, readable and memorable.',
  },
  marcus: {
    id: 'marcus',
    name: 'Marcus Feld',
    headline: 'Principal Cloud Architect, 6x certified',
    photo: '/images/instructors/marcus-feld.jpg',
    rating: 4.6,
    reviews: 61877,
    students: 401255,
    courses: 2,
    bio: 'Marcus designs cloud platforms for companies moving out of their data centres. He has run migrations for banks, hospitals and start-ups, and explains infrastructure without the jargon.',
  },
  sofia: {
    id: 'sofia',
    name: 'Sofia Lindqvist',
    headline: 'Staff Engineer, serverless and event-driven systems',
    photo: '/images/instructors/sofia-lindqvist.jpg',
    rating: 4.7,
    reviews: 22408,
    students: 140377,
    courses: 1,
    bio: 'Sofia has shipped serverless systems that handle millions of events a day. She cares about observability, sensible defaults and deployments that let teams sleep at night.',
  },
  helen: {
    id: 'helen',
    name: 'Helen Brooks',
    headline: 'Executive coach and leadership facilitator',
    photo: '/images/instructors/helen-brooks.jpg',
    rating: 4.8,
    reviews: 39550,
    students: 254019,
    courses: 2,
    bio: 'Helen coaches new and experienced managers in technology and healthcare. Before coaching she led operations teams of up to 120 people, and she brings practical, tested habits to every lesson.',
  },
  james: {
    id: 'james',
    name: 'James Whitaker',
    headline: 'Organisational psychologist and facilitator',
    photo: '/images/instructors/james-whitaker.jpg',
    rating: 4.5,
    reviews: 9821,
    students: 71566,
    courses: 1,
    bio: 'James has facilitated thousands of workshops and leadership off-sites. His research focuses on how small changes to meetings give teams back hours every week.',
  },
  elena: {
    id: 'elena',
    name: 'Elena Moreau',
    headline: 'Head of UX Research',
    photo: '/images/instructors/elena-moreau.jpg',
    rating: 4.7,
    reviews: 18240,
    students: 120983,
    courses: 1,
    bio: 'Elena has built research practices from scratch at three product companies. She teaches lightweight methods that fit into real product timelines and budgets.',
  },
  tomas: {
    id: 'tomas',
    name: 'Tomás Rivera',
    headline: 'Product Designer and design systems lead',
    photo: '/images/instructors/tomas-rivera.jpg',
    rating: 4.6,
    reviews: 27315,
    students: 189640,
    courses: 2,
    bio: 'Tomás leads the design system at a large SaaS company and has spoken about interaction patterns at design conferences across Europe and Latin America.',
  },
};

const COURSE_META = {
  crs_b90cee164369: {
    slug: 'sql-for-analysts', instructor: 'priya', rating: 4.7, ratingCount: 38412, students: 214305,
    price: 19.99, listPrice: 109.99, badge: 'Bestseller', updated: '10/2026',
    sections: [['Querying the basics', 4], ['Combining and shaping data', 4]],
    outcomes: ['Write SELECT queries that filter, sort and limit results', 'Summarise data with GROUP BY and aggregate functions', 'Combine tables with inner, left and full joins', 'Break hard problems into CTEs and subqueries', 'Rank and compare rows with window functions', 'Write SQL your teammates can read and review'],
    requirements: ['No prior SQL experience needed', 'A computer with a web browser', 'Comfort with spreadsheets helps but is not required'],
    audience: ['Analysts who rely on others to pull data for them', 'Spreadsheet power users ready for the next step', 'Product managers who want to answer their own questions'],
  },
  crs_7860762e4a50: {
    slug: 'data-visualization', instructor: 'daniel', rating: 4.8, ratingCount: 12077, students: 76540,
    price: 17.99, listPrice: 89.99, badge: 'Highest Rated', updated: '09/2026',
    sections: [['Seeing data clearly', 4], ['Charts that answer questions', 3]],
    outcomes: ['Pick the right chart for every kind of comparison', 'Use colour to highlight, not decorate', 'Write titles and annotations that tell the story', 'Design small multiples and dashboards people use', 'Spot and fix misleading charts', 'Critique a chart with a repeatable checklist'],
    requirements: ['Any charting tool: Excel, Google Sheets, Tableau or Python', 'No design background needed'],
    audience: ['Analysts and researchers who present data', 'Managers who build reports for leadership', 'Anyone tired of default chart settings'],
  },
  crs_a8ce4b76e021: {
    slug: 'python-for-data', instructor: 'priya', rating: 4.6, ratingCount: 27530, students: 168211,
    price: 19.99, listPrice: 119.99, badge: 'Bestseller', updated: '11/2026',
    sections: [['Python foundations', 5], ['Working with real data', 4]],
    outcomes: ['Set up a clean Python environment in minutes', 'Use lists, dictionaries and comprehensions fluently', 'Read and write CSV and JSON files', 'Clean messy, real-world datasets', 'Summarise and group data for reporting', 'Automate a weekly report end to end'],
    requirements: ['No programming experience required', 'Windows, macOS or Linux computer'],
    audience: ['Analysts who want to automate repetitive work', 'Excel users hitting the limits of spreadsheets', 'Beginners who want a practical first language'],
  },
  crs_e309862052b0: {
    slug: 'cloud-foundations', instructor: 'marcus', rating: 4.6, ratingCount: 45120, students: 289004,
    price: 14.99, listPrice: 94.99, badge: 'Bestseller', updated: '10/2026',
    sections: [['Core cloud concepts', 4], ['Running workloads safely', 4]],
    outcomes: ['Explain regions, availability zones and edge locations', 'Choose between virtual machines, containers and functions', 'Pick the right storage service for each workload', 'Design a simple, secure virtual network', 'Apply least-privilege identity and access', 'Estimate and control monthly cloud costs'],
    requirements: ['Basic IT literacy', 'No cloud account needed to follow along'],
    audience: ['Developers and IT staff new to the cloud', 'Managers who need to talk confidently with engineers', 'Anyone preparing for an entry-level cloud certification'],
  },
  crs_9a1f97c7ca36: {
    slug: 'serverless', instructor: 'sofia', rating: 4.7, ratingCount: 9634, students: 58219,
    price: 18.99, listPrice: 109.99, badge: 'Hot & New', updated: '11/2026',
    sections: [['Event-driven building blocks', 4], ['Production-ready serverless', 3]],
    outcomes: ['Model your application as events and handlers', 'Build HTTP APIs with functions and gateways', 'Decouple services with queues and streams', 'Choose the right managed store for state', 'Trace, log and alert on serverless workloads', 'Ship safely with staged deployments'],
    requirements: ['Comfortable writing code in one language', 'Basic understanding of HTTP APIs'],
    audience: ['Back-end developers moving to the cloud', 'Teams replacing always-on servers', 'Engineers who want lower operating costs'],
  },
  crs_6946647457ca: {
    slug: 'infrastructure-as-code', instructor: 'marcus', rating: 4.5, ratingCount: 14289, students: 92340,
    price: 16.99, listPrice: 99.99, badge: null, updated: '08/2026',
    sections: [['Thinking in code', 3], ['Operating infrastructure code', 3]],
    outcomes: ['Describe infrastructure as versioned, reviewable code', 'Compare declarative and imperative tools', 'Package reusable stacks and modules', 'Detect and correct configuration drift', 'Test infrastructure before it reaches production', 'Deliver infrastructure changes through pipelines'],
    requirements: ['Familiarity with at least one cloud provider', 'Basic command-line skills'],
    audience: ['DevOps and platform engineers', 'Developers who manage their own environments', 'Ops teams moving away from manual changes'],
  },
  crs_4f46a0255ad4: {
    slug: 'first-time-manager', instructor: 'helen', rating: 4.8, ratingCount: 31876, students: 197455,
    price: 19.99, listPrice: 129.99, badge: 'Bestseller', updated: '10/2026',
    sections: [['Stepping into the role', 4], ['Leading your team', 4]],
    outcomes: ['Make the shift from doing the work to leading it', 'Set clear expectations from day one', 'Run one-on-ones your team looks forward to', 'Delegate work without losing quality', 'Build trust and recognise good work', 'Plan a confident first 90 days'],
    requirements: ['No management experience needed', 'An open mind and a notebook'],
    audience: ['Newly promoted managers and team leads', 'Individual contributors considering management', 'HR partners supporting new managers'],
  },
  crs_050fbff86d75: {
    slug: 'effective-meetings', instructor: 'james', rating: 4.5, ratingCount: 6210, students: 41322,
    price: 12.99, listPrice: 74.99, badge: null, updated: '07/2026',
    sections: [['Before the meeting', 3], ['In the room and after', 3]],
    outcomes: ['Decide when a meeting is really needed', 'Write agendas that drive outcomes', 'Facilitate discussions with confidence', 'Reach decisions everyone can commit to', 'Run inclusive remote and hybrid meetings', 'Close the loop with useful notes and follow-ups'],
    requirements: ['None, just bring your calendar'],
    audience: ['Anyone who runs or attends a lot of meetings', 'Team leads and project managers', 'Remote and hybrid teams'],
  },
  crs_d7a7ea843274: {
    slug: 'feedback-conversations', instructor: 'helen', rating: 4.7, ratingCount: 18905, students: 120762,
    price: 17.99, listPrice: 99.99, badge: 'Highest Rated', updated: '09/2026',
    sections: [['Preparing for feedback', 4], ['Navigating the conversation', 3]],
    outcomes: ['Give feedback with a simple, repeatable model', 'Prepare calmly for a difficult conversation', 'Listen actively when emotions run high', 'Respond to defensiveness without escalating', 'Agree on concrete next steps', 'Receive feedback with curiosity'],
    requirements: ['No prior training required'],
    audience: ['Managers who avoid hard conversations', 'Colleagues who want to give better peer feedback', 'Anyone preparing for a performance review'],
  },
  crs_49d1f5560903: {
    slug: 'ux-research', instructor: 'elena', rating: 4.7, ratingCount: 8790, students: 63118,
    price: 16.99, listPrice: 94.99, badge: null, updated: '10/2026',
    sections: [['Planning research', 4], ['From sessions to insights', 4]],
    outcomes: ['Frame research questions that matter to the business', 'Recruit the right participants quickly', 'Run interviews that uncover real needs', 'Plan and moderate usability tests', 'Synthesise findings into clear insights', 'Run useful research on a small budget'],
    requirements: ['No research background needed', 'Interest in how people use products'],
    audience: ['Designers who want to validate their work', 'Product managers making decisions with evidence', 'Career changers moving into UX'],
  },
  crs_0b6e283665c9: {
    slug: 'interaction-design', instructor: 'tomas', rating: 4.6, ratingCount: 11532, students: 81904,
    price: 18.99, listPrice: 109.99, badge: 'Hot & New', updated: '11/2026',
    sections: [['Core interaction patterns', 5], ['Patterns for complex products', 5]],
    outcomes: ['Choose proven patterns for navigation and forms', 'Design clear feedback and system status', 'Turn empty states into helpful moments', 'Help users recover from errors gracefully', 'Design usable tables, search and filtering', 'Build accessibility into every interaction'],
    requirements: ['Basic familiarity with a design tool like Figma'],
    audience: ['Product and UI designers', 'Front-end developers who build interfaces', 'Product managers reviewing designs'],
  },
  crs_f0c5c2d05729: {
    slug: 'design-systems', instructor: 'tomas', rating: 4.6, ratingCount: 7425, students: 52810,
    price: 19.99, listPrice: 114.99, badge: null, updated: '09/2026',
    sections: [['Building the system', 5], ['Running the system', 4]],
    outcomes: ['Define design tokens that scale across products', 'Design flexible components and variants', 'Write documentation people actually read', 'Set up governance and contribution models', 'Version and release changes safely', 'Measure adoption and impact'],
    requirements: ['Experience designing or building user interfaces'],
    audience: ['Designers and engineers starting a design system', 'Teams struggling with inconsistent UI', 'Design leaders planning for scale'],
  },
};

const FALLBACK_META = {
  slug: null, instructor: 'priya', rating: 4.5, ratingCount: 1200, students: 8400,
  price: 14.99, listPrice: 84.99, badge: null, updated: '11/2026', sections: [],
  outcomes: [], requirements: [], audience: [],
};

/** Display-only details for a course id. Always returns an object. */
export function courseMeta(courseId) {
  const meta = COURSE_META[courseId] ?? FALLBACK_META;
  return {
    ...meta,
    image: meta.slug ? `/images/courses/${meta.slug}.jpg` : '/images/courses/preview-fallback.jpg',
    instructor: INSTRUCTORS[meta.instructor],
    discountPercent: Math.round((1 - meta.price / meta.listPrice) * 100),
  };
}

/** Group a lesson outline into sections, following COURSE_META.sections sizes. */
export function groupLessons(courseId, lessons) {
  const sizes = COURSE_META[courseId]?.sections ?? [];
  const groups = [];
  let start = 0;
  sizes.forEach(([title, count], i) => {
    const isLast = i === sizes.length - 1;
    const items = lessons.slice(start, isLast ? lessons.length : start + count);
    start += count;
    if (items.length) groups.push({ title, lessons: items });
  });
  if (!groups.length) groups.push({ title: 'Course lessons', lessons });
  return groups;
}

/** Percent of reviews at 5..1 stars, derived from the average rating. */
export function ratingBreakdown(rating) {
  if (rating >= 4.75) return [78, 17, 4, 1, 0];
  if (rating >= 4.65) return [69, 23, 6, 1, 1];
  if (rating >= 4.55) return [62, 28, 7, 2, 1];
  return [55, 31, 10, 3, 1];
}

const REVIEWS_BY_CATEGORY = {
  Data: [
    { name: 'Laura M.', photo: '/images/instructors/reviewer-1.jpg', rating: 5, when: '2 weeks ago', text: 'Clear, practical and straight to the point. I used what I learned at work the very next day and finally stopped waiting on the data team for simple numbers.' },
    { name: 'Rahul S.', rating: 5, when: '1 month ago', text: 'The examples are realistic, not toy problems. The quizzes at the end of each section really helped the concepts stick.' },
    { name: 'Chen W.', rating: 4, when: '1 month ago', text: 'Great pacing for beginners. I would have loved one more exercise on the advanced topics, but overall excellent value.' },
    { name: 'Ana P.', photo: '/images/instructors/reviewer-2.jpg', rating: 5, when: '3 months ago', text: 'The instructor explains why, not just how. This is the course I wish I had taken two years ago.' },
  ],
  Cloud: [
    { name: 'Tobias K.', photo: '/images/instructors/reviewer-3.jpg', rating: 5, when: '3 weeks ago', text: 'Finally a cloud course that does not drown you in service names. The mental models are what made it click for me.' },
    { name: 'Fatima A.', rating: 4, when: '1 month ago', text: 'Very well structured. The cost-awareness lesson alone saved my team real money this quarter.' },
    { name: 'George L.', rating: 5, when: '2 months ago', text: 'Concise lessons and great diagrams. I passed my associate exam after following this alongside the official docs.' },
    { name: 'Mina J.', photo: '/images/instructors/reviewer-1.jpg', rating: 5, when: '4 months ago', text: 'Practical and current. I appreciated the focus on designing for failure from the very start.' },
  ],
  Leadership: [
    { name: 'Sarah D.', photo: '/images/instructors/reviewer-2.jpg', rating: 5, when: '1 week ago', text: 'I was promoted last month and felt lost. This course gave me a plan for my first one-on-ones and my team noticed the difference immediately.' },
    { name: 'Michael B.', rating: 5, when: '1 month ago', text: 'Warm, honest and full of scripts you can actually use. I keep coming back to the delegation lesson.' },
    { name: 'Priyanka V.', rating: 4, when: '2 months ago', text: 'Short lessons that respect your time. Some of it was familiar, but the frameworks are excellent.' },
    { name: 'Owen T.', photo: '/images/instructors/reviewer-3.jpg', rating: 5, when: '3 months ago', text: 'Best leadership training I have done, including the expensive in-person workshop my company paid for.' },
  ],
  Design: [
    { name: 'Lucía R.', photo: '/images/instructors/reviewer-1.jpg', rating: 5, when: '5 days ago', text: 'Full of real product examples. I redesigned our onboarding flow using the patterns from this course and conversions went up.' },
    { name: 'Ben H.', rating: 4, when: '3 weeks ago', text: 'Solid, well-paced content. The accessibility lesson should be required viewing for every product team.' },
    { name: 'Aisha N.', photo: '/images/instructors/reviewer-2.jpg', rating: 5, when: '2 months ago', text: 'Practical and inspiring. The templates and checklists are worth the price on their own.' },
    { name: 'Kenji O.', rating: 5, when: '3 months ago', text: 'Clear explanations and great critique of real interfaces. I learned a lot about why some patterns work.' },
  ],
};

export function reviewsFor(category) {
  return REVIEWS_BY_CATEGORY[category] ?? REVIEWS_BY_CATEGORY.Data;
}

export const CATEGORIES = [
  { name: 'Data', image: '/images/categories/data.jpg', learners: '1.2M', topics: [['SQL', '486,210'], ['Python', '1,034,512'], ['Data Visualization', '212,906'], ['Excel', '845,330']] },
  { name: 'Cloud', image: '/images/categories/cloud.jpg', learners: '980K', topics: [['Cloud Computing', '741,288'], ['Serverless', '128,904'], ['Terraform', '210,077'], ['DevOps', '602,415']] },
  { name: 'Leadership', image: '/images/categories/leadership.jpg', learners: '760K', topics: [['Management', '1,402,118'], ['Communication', '988,042'], ['Meetings', '96,310'], ['Coaching', '173,520']] },
  { name: 'Design', image: '/images/categories/design.jpg', learners: '640K', topics: [['UX Design', '702,466'], ['User Research', '154,882'], ['Figma', '418,219'], ['Design Systems', '88,740']] },
];

export const POPULAR_SEARCHES = ['SQL', 'Python', 'Cloud', 'Leadership', 'UX', 'Serverless', 'Design systems', 'Feedback'];

export const HERO_SLIDES = [
  {
    image: '/images/banners/hero-learning.jpg',
    title: 'Learning that gets you',
    text: 'Skills for your present (and your future). New and updated courses are added to the catalog every month.',
  },
  {
    image: '/images/banners/hero-skills.jpg',
    title: 'Keep the streak going',
    text: 'A few minutes a day adds up. Pick up where you left off, or start something new from our top-rated courses.',
  },
];

export const PLAN = {
  name: 'Personal Plan',
  features: ['Access to every course in the catalog', 'Practice quizzes in every course', 'Learn at your own pace on any device', 'Cancel anytime'],
};

/** Simple text search over title, summary, category and instructor. */
export function matchesQuery(course, query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  const meta = courseMeta(course.id);
  return [course.title, course.summary, course.category, meta.instructor?.name].some((v) => v?.toLowerCase().includes(q));
}

export const formatPrice = (usd) => `$${usd.toFixed(2)}`;
export const formatCount = (n) => n.toLocaleString('en-US');
