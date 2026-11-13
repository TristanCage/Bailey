/**
 * vCard / contact-card helpers.
 * Ported from @innovatorssoft/baileys (MIT, innovatorssoft) with attribution.
 */

const escapeVCard = str =>
	String(str ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\n/g, '\\n');

const formatPhone = phone => String(phone ?? '').replace(/[^\d+]/g, '');

/** Generate a vCard 3.0 string from contact data. */
export const generateVCard = contact => {
	const lines = [];
	lines.push('BEGIN:VCARD');
	lines.push('VERSION:3.0');
	const escapedName = escapeVCard(contact.fullName);
	lines.push(`FN:${escapedName}`);
	const nameParts = String(contact.fullName ?? '').split(' ');
	if (nameParts.length >= 2) {
		const lastName = nameParts[nameParts.length - 1] || '';
		const firstName = nameParts.slice(0, -1).join(' ');
		lines.push(`N:${escapeVCard(lastName)};${escapeVCard(firstName)};;;`);
	} else {
		lines.push(`N:${escapedName};;;;`);
	}
	if (contact.organization) lines.push(`ORG:${escapeVCard(contact.organization)}`);
	if (contact.title) lines.push(`TITLE:${escapeVCard(contact.title)}`);
	for (const phone of contact.phones ?? []) {
		const type = phone.type || 'CELL';
		const formatted = formatPhone(phone.number);
		if (phone.label) lines.push(`TEL;type=${type};type=VOICE;X-ABLabel=${escapeVCard(phone.label)}:${formatted}`);
		else lines.push(`TEL;type=${type};type=VOICE:${formatted}`);
	}
	for (const email of contact.emails ?? []) {
		lines.push(`EMAIL;type=${email.type || 'OTHER'}:${email.email}`);
	}
	for (const url of contact.urls ?? []) {
		lines.push(`URL;type=${url.type || 'OTHER'}:${url.url}`);
	}
	for (const address of contact.addresses ?? []) {
		const parts = [
			'',
			'',
			address.street || '',
			address.city || '',
			address.state || '',
			address.postalCode || '',
			address.country || ''
		].map(escapeVCard);
		lines.push(`ADR;type=${address.type || 'OTHER'}:${parts.join(';')}`);
	}
	if (contact.birthday) lines.push(`BDAY:${contact.birthday}`);
	if (contact.note) lines.push(`NOTE:${escapeVCard(contact.note)}`);
	lines.push('END:VCARD');
	return lines.join('\r\n');
};

export const generateVCards = contacts => contacts.map(generateVCard).join('\r\n');

/** Basic vCard parser. */
export const parseVCard = vcard => {
	const contact = {};
	for (const line of String(vcard).split(/\r?\n/)) {
		const [key, ...valueParts] = line.split(':');
		if (!key) continue;
		const value = valueParts.join(':');
		if (key.startsWith('FN')) contact.fullName = value.replace(/\\([;,n\\])/g, '$1').replace(/\\n/g, '\n');
		else if (key.startsWith('ORG')) contact.organization = value.replace(/\\([;,n\\])/g, '$1');
		else if (key.startsWith('TITLE')) contact.title = value.replace(/\\([;,n\\])/g, '$1');
		else if (key.startsWith('TEL')) {
			contact.phones = contact.phones || [];
			const typeMatch = key.match(/type=(\w+)/i);
			contact.phones.push({ number: value, type: typeMatch?.[1]?.toUpperCase() || 'CELL' });
		} else if (key.startsWith('EMAIL')) {
			contact.emails = contact.emails || [];
			const typeMatch = key.match(/type=(\w+)/i);
			contact.emails.push({ email: value, type: typeMatch?.[1]?.toUpperCase() || 'OTHER' });
		} else if (key.startsWith('BDAY')) contact.birthday = value;
		else if (key.startsWith('NOTE')) contact.note = value.replace(/\\n/g, '\n');
	}
	return contact;
};

/** Message content for a single contact card. */
export const createContactCard = contact => ({
	contacts: {
		displayName: contact.displayName || contact.fullName,
		contacts: [{ vcard: generateVCard(contact) }]
	}
});

/** Message content for multiple contact cards. */
export const createContactCards = contacts => {
	const first = contacts[0];
	return {
		contacts: {
			displayName: contacts.length === 1 && first ? first.displayName || first.fullName : `${contacts.length} Contacts`,
			contacts: contacts.map(contact => ({ vcard: generateVCard(contact) }))
		}
	};
};

/** Quick contact definition from a name + phone number. */
export const quickContact = (name, phone, options) => ({
	fullName: name,
	phones: [{ number: phone, type: 'CELL' }],
	organization: options?.organization,
	emails: options?.email ? [{ email: options.email, type: 'WORK' }] : undefined
});
