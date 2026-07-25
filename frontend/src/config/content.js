/**
 * Static content / legal pages — the single source of truth for the storefront's
 * About, Contact, Terms of Service and Privacy Policy pages.
 *
 * Content lives here as structured data (title + ordered sections) and is rendered
 * by a single generic view (@/views/ContentPageView.vue), so adding or editing a
 * page never touches component code and every page renders identically.
 *
 * NOTE: the Terms and Privacy copy below is a good-faith template covering the
 * standard sections a store handling PII + payments needs. It MUST be reviewed and
 * finalised by legal counsel — and STORE_INFO filled with the real legal entity,
 * jurisdiction and contact details — before go-live. Placeholders are centralised
 * in STORE_INFO precisely so that review is a one-file change.
 */

/**
 * @typedef {Object} ContentSection
 * @property {string}   [heading]     Optional sub-heading for the section.
 * @property {string[]} paragraphs    One or more prose paragraphs.
 */

/**
 * @typedef {Object} ContentPage
 * @property {string}          title          Page heading + document <title>.
 * @property {string}          [effective]    ISO date the document takes effect.
 * @property {string}          [intro]        Lead paragraph shown above sections.
 * @property {ContentSection[]} sections      Ordered body sections.
 */

/** Central place for the identity/contact details woven through the pages. */
export const STORE_INFO = {
    name:         'Storefront',
    legalEntity:  'Storefront, Inc.',       // TODO(legal): real registered entity
    jurisdiction: 'the State of Delaware, USA', // TODO(legal): governing law
    contactEmail: 'support@storefront.example',
    privacyEmail: 'privacy@storefront.example',
    postalAddress: '123 Commerce Street, Suite 100, Wilmington, DE 19801, USA',
    /**
     * Where the source of THIS deployment can be obtained.
     *
     * This project is licensed AGPL-3.0-or-later. Section 13 requires that users
     * interacting with a modified version over a network be offered its source,
     * and a link in the interface is the conventional way to discharge that. Set
     * this to your own repository (or a source archive) when you deploy; the
     * footer renders the credit as plain text while it is empty, so an unset
     * value never advertises an offer that does not exist.
     */
    sourceUrl:    '',
};

/** Effective date stamped on the legal documents. */
const EFFECTIVE_DATE = '2026-07-21';

/** @type {Record<string, ContentPage>} keyed by URL slug. */
export const CONTENT_PAGES = {
    about: {
        title: `About ${STORE_INFO.name}`,
        intro: `${STORE_INFO.name} is an online store built to make finding, buying and `
            + `receiving the things you want straightforward and dependable.`,
        sections: [
            {
                heading: 'What we do',
                paragraphs: [
                    `We sell a curated catalogue of products and ship them from our own `
                    + `warehouses. Orders are picked, packed and tracked end to end so you `
                    + `always know where your purchase is.`,
                ],
            },
            {
                heading: 'How we operate',
                paragraphs: [
                    `Inventory is managed across multiple warehouses with real-time stock `
                    + `levels, so what you see available is what we can actually ship. If an `
                    + `item is temporarily out of stock, you can ask to be notified the moment `
                    + `it returns.`,
                    `Returns are handled through a straightforward RMA process within the `
                    + `return window shown at checkout.`,
                ],
            },
            {
                heading: 'Get in touch',
                paragraphs: [
                    `Questions about an order or a product? See our Contact page — we read `
                    + `every message.`,
                ],
            },
        ],
    },

    contact: {
        title: 'Contact Us',
        intro: `We're happy to help with orders, returns, products or anything else.`,
        sections: [
            {
                heading: 'Customer support',
                paragraphs: [
                    `Email us at ${STORE_INFO.contactEmail} and we'll get back to you as soon `
                    + `as we can, typically within one business day.`,
                    `If your question is about a specific order, include your order number so `
                    + `we can help you faster.`,
                ],
            },
            {
                heading: 'Privacy requests',
                paragraphs: [
                    `For questions about your personal data, or to request a copy or deletion `
                    + `of it, email ${STORE_INFO.privacyEmail}. See our Privacy Policy for what `
                    + `we collect and your rights.`,
                ],
            },
            {
                heading: 'Postal address',
                paragraphs: [STORE_INFO.postalAddress],
            },
        ],
    },

    terms: {
        title: 'Terms of Service',
        effective: EFFECTIVE_DATE,
        intro: `These Terms of Service ("Terms") govern your access to and use of `
            + `${STORE_INFO.name}, operated by ${STORE_INFO.legalEntity} ("we", "us"). By `
            + `browsing, creating an account or placing an order, you agree to these Terms.`,
        sections: [
            {
                heading: '1. Accounts',
                paragraphs: [
                    `You are responsible for the activity on your account and for keeping your `
                    + `login secure. You must provide accurate information and be old enough to `
                    + `form a binding contract in your jurisdiction.`,
                ],
            },
            {
                heading: '2. Orders and pricing',
                paragraphs: [
                    `An order is an offer to buy. We accept it when we confirm and charge your `
                    + `payment method, and we may decline or cancel an order — for example if an `
                    + `item is mispriced, out of stock, or the order appears fraudulent. Prices `
                    + `and availability may change before an order is accepted.`,
                ],
            },
            {
                heading: '3. Payment',
                paragraphs: [
                    `You authorise us to charge your chosen payment method for the total shown at `
                    + `checkout, including taxes and shipping. Payments are processed by a `
                    + `third-party payment provider; we do not store full card numbers.`,
                ],
            },
            {
                heading: '4. Shipping, returns and refunds',
                paragraphs: [
                    `We ship to the address you provide and share tracking where available. `
                    + `Eligible items may be returned within the return window shown at checkout `
                    + `through our RMA process; approved refunds are issued to the original `
                    + `payment method.`,
                ],
            },
            {
                heading: '5. Acceptable use',
                paragraphs: [
                    `You agree not to misuse the service, interfere with its operation, attempt `
                    + `to access it in unauthorised ways, or use it to break the law.`,
                ],
            },
            {
                heading: '6. Disclaimers and liability',
                paragraphs: [
                    `The service is provided "as is" without warranties of any kind to the extent `
                    + `permitted by law. To the maximum extent permitted by law, our liability `
                    + `arising from these Terms or your use of the service is limited to the `
                    + `amount you paid for the order giving rise to the claim.`,
                ],
            },
            {
                heading: '7. Changes and governing law',
                paragraphs: [
                    `We may update these Terms; material changes take effect when we post the `
                    + `updated version with a new effective date. These Terms are governed by the `
                    + `laws of ${STORE_INFO.jurisdiction}.`,
                    `Questions about these Terms: ${STORE_INFO.contactEmail}.`,
                ],
            },
        ],
    },

    privacy: {
        title: 'Privacy Policy',
        effective: EFFECTIVE_DATE,
        intro: `This Privacy Policy explains what personal data ${STORE_INFO.legalEntity} `
            + `("we", "us") collects when you use ${STORE_INFO.name}, how we use it, and the `
            + `rights you have over it.`,
        sections: [
            {
                heading: 'Information we collect',
                paragraphs: [
                    `Account details you give us (such as your email address and name), order `
                    + `and shipping information, and communications you send us. We also collect `
                    + `limited technical data such as your IP address and request logs, used to `
                    + `operate and secure the service.`,
                    `Payment card details are handled by our payment provider — we do not store `
                    + `full card numbers.`,
                ],
            },
            {
                heading: 'How we use it',
                paragraphs: [
                    `To process and deliver your orders, provide customer support, prevent fraud `
                    + `and abuse, meet legal and accounting obligations, and — where you have `
                    + `opted in — to send notifications such as back-in-stock alerts.`,
                ],
            },
            {
                heading: 'Sharing',
                paragraphs: [
                    `We share personal data only with the service providers needed to run the `
                    + `store (such as payment, email and shipping providers), and where required `
                    + `by law. We do not sell your personal data.`,
                ],
            },
            {
                heading: 'Retention',
                paragraphs: [
                    `We keep personal data for as long as your account is active and as needed to `
                    + `fulfil orders, then for the period required to meet legal, tax and `
                    + `accounting obligations, after which it is deleted or anonymised.`,
                ],
            },
            {
                heading: 'Your rights',
                paragraphs: [
                    `Depending on where you live, you may have the right to access, correct, `
                    + `export or delete your personal data, and to object to or restrict certain `
                    + `processing. To exercise these rights, email ${STORE_INFO.privacyEmail}. `
                    + `You also have the right to withdraw marketing consent at any time.`,
                ],
            },
            {
                heading: 'Contact',
                paragraphs: [
                    `Questions about this policy or your data: ${STORE_INFO.privacyEmail}, or by `
                    + `post at ${STORE_INFO.postalAddress}.`,
                ],
            },
        ],
    },
};

/** URL slug → nav label, used to build the storefront footer links in order. */
export const CONTENT_NAV = [
    { slug: 'about',   label: 'About' },
    { slug: 'contact', label: 'Contact' },
    { slug: 'terms',   label: 'Terms of Service' },
    { slug: 'privacy', label: 'Privacy Policy' },
];
