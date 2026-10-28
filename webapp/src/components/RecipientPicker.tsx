import React from 'react';

import {PersonAvatar} from './avatar';
import {CloseIcon, Spinner} from './icons';

import {api} from '../api';
import type {Contact, MattermostUser} from '../types';

// A recipient chosen in the composer: a Mattermost user (their e-mail is
// resolved on the server) or a plain e-mail address.
export interface Participant {
    key: string;
    userId?: string;
    email?: string;
    label: string;
    sublabel?: string;
}

const EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

export function isEmail(value: string) {
    return EMAIL_RE.test(value.trim());
}

export function participantFromUser(u: MattermostUser): Participant {
    return {key: `u:${u.id}`, userId: u.id, label: u.display_name || u.username, sublabel: `@${u.username}`};
}

export function participantFromEmail(email: string, name = ''): Participant {
    const clean = email.trim().toLowerCase();
    return {key: `e:${clean}`, email: clean, label: name || clean, sublabel: name ? clean : undefined};
}

// The address book from the mail history is loaded once per few minutes
// and filtered in the browser, so suggestions appear while typing.
const CONTACTS_TTL = 5 * 60 * 1000;
let contactsCache: {at: number; list: Promise<Contact[]>} | null = null;

export function loadContacts(): Promise<Contact[]> {
    if (!contactsCache || Date.now() - contactsCache.at > CONTACTS_TTL) {
        const list = api.contacts().then((r) => r.contacts).catch(() => {
            contactsCache = null;
            return [] as Contact[];
        });
        contactsCache = {at: Date.now(), list};
    }
    return contactsCache.list;
}

export function forgetContacts() {
    contactsCache = null;
}

// matchContact finds people by the beginning of any word of the name or
// of the address ("пет" finds Ольга Петрова and petrova@…), and anywhere
// in the address once enough is typed.
export function matchContact(c: Contact, term: string) {
    const t = term.trim().toLowerCase();
    if (!t) {
        return true;
    }
    const words = [...(c.name || '').toLowerCase().split(/[\s.,"'()-]+/), ...c.email.split(/[@._-]+/)];
    return words.some((w) => w.startsWith(t)) || c.email.startsWith(t) || (t.length >= 3 && c.email.includes(t));
}

interface Suggestion {
    key: string;
    group: 'history' | 'mattermost';
    label: string;
    sub: string;
    email?: string;
    userId?: string;
    participant: Participant;
}

function groupTitle(group: Suggestion['group'], typing: boolean) {
    if (group === 'mattermost') {
        return 'В Mattermost';
    }
    return typing ? 'Из переписки' : 'Часто пишете';
}

const MAX_HISTORY = 6;
const MAX_USERS = 6;

export default function RecipientPicker({value, onChange, disabled, autoFocus, placeholder = 'Имя коллеги или адрес почты'}: {
    value: Participant[];
    onChange: (v: Participant[]) => void;
    disabled?: boolean;
    autoFocus?: boolean;
    placeholder?: string;
}) {
    const [text, setText] = React.useState('');
    const [results, setResults] = React.useState<MattermostUser[]>([]);
    const [contacts, setContacts] = React.useState<Contact[]>([]);
    const [searching, setSearching] = React.useState(false);
    const [active, setActive] = React.useState(0);
    const [open, setOpen] = React.useState(false);
    const inputRef = React.useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        if (autoFocus) {
            inputRef.current?.focus();
        }
        loadContacts().then(setContacts);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    React.useEffect(() => {
        const term = text.trim();
        if (term.length < 2 || isEmail(term)) {
            setResults([]);
            setSearching(false);
            return undefined;
        }
        setSearching(true);
        const timer = window.setTimeout(() => {
            api.searchUsers(term).
                then((res) => {
                    setResults(res.users);
                    setActive(0);
                }).
                catch(() => setResults([])).
                finally(() => setSearching(false));
        }, 250);
        return () => window.clearTimeout(timer);
    }, [text]);

    const add = (p: Participant) => {
        if (!value.some((v) => v.key === p.key)) {
            onChange([...value, p]);
        }
        setText('');
        setResults([]);
        inputRef.current?.focus();
    };

    const remove = (key: string) => onChange(value.filter((v) => v.key !== key));

    // Several addresses can be pasted at once, e.g. from an e-mail.
    const addEmails = (raw: string) => {
        const emails = raw.split(/[\s,;]+/).map((s) => s.replace(/^<|>$/g, '')).filter(isEmail);
        if (emails.length === 0) {
            return false;
        }
        const next = [...value];
        for (const e of emails) {
            const p = participantFromEmail(e);
            if (!next.some((v) => v.key === p.key)) {
                next.push(p);
            }
        }
        onChange(next);
        setText('');
        setResults([]);
        return true;
    };

    const chosen = new Set(value.map((v) => v.email || v.userId));
    const history: Suggestion[] = contacts.
        filter((c) => !chosen.has(c.email) && matchContact(c, text)).
        slice(0, text.trim() ? MAX_HISTORY : 5).
        map((c) => ({
            key: `h:${c.email}`,
            group: 'history',
            label: c.name || c.email,
            sub: c.name ? c.email : '',
            email: c.email,
            userId: c.user_id,
            participant: participantFromEmail(c.email, c.name),
        }));
    const inHistory = new Set(history.map((h) => h.userId).filter(Boolean));
    const people: Suggestion[] = results.
        filter((u) => !value.some((v) => v.userId === u.id) && !inHistory.has(u.id)).
        slice(0, MAX_USERS).
        map((u) => ({
            key: `u:${u.id}`,
            group: 'mattermost',
            label: u.display_name || u.username,
            sub: u.email || `@${u.username}`,
            email: u.email,
            userId: u.id,
            participant: participantFromUser(u),
        }));
    const suggestions = [...history, ...people];
    const typedEmail = isEmail(text) ? text.trim() : '';

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, Math.max(suggestions.length - 1, 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
        } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
            if (suggestions[active] && e.key === 'Enter') {
                e.preventDefault();
                add(suggestions[active].participant);
            } else if (text.trim() && addEmails(text)) {
                e.preventDefault();
            } else if (e.key === 'Enter') {
                e.preventDefault();
            }
        } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
            remove(value[value.length - 1].key);
        }
    };

    return (
        <div className='mml-picker'>
            <div
                className={`mml-picker__box ${disabled ? 'mml-picker__box--disabled' : ''}`}
                onClick={() => inputRef.current?.focus()}
            >
                {value.map((p) => (
                    <span
                        key={p.key}
                        className='mml-picker__chip'
                        title={p.sublabel || p.email}
                    >
                        <PersonAvatar
                            email={p.email || ''}
                            name={p.sublabel ? p.label : undefined}
                            userId={p.userId}
                            size={20}
                            className='mml-avatar'
                        />
                        {p.label}
                        <button
                            type='button'
                            onClick={(e) => {
                                e.stopPropagation();
                                remove(p.key);
                            }}
                            aria-label={`Убрать ${p.label}`}
                        >
                            <CloseIcon size={12}/>
                        </button>
                    </span>
                ))}
                <input
                    ref={inputRef}
                    className='mml-picker__input'
                    value={text}
                    disabled={disabled}
                    placeholder={value.length ? '' : placeholder}
                    onChange={(e) => {
                        setText(e.target.value);
                        setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => {
                        // An address typed without Enter is not lost.
                        if (isEmail(text)) {
                            addEmails(text);
                        }
                        window.setTimeout(() => setOpen(false), 150);
                    }}
                    onKeyDown={onKeyDown}
                    onPaste={(e) => {
                        const pasted = e.clipboardData.getData('text');
                        if ((/[,;\s]/).test(pasted.trim()) && addEmails(pasted)) {
                            e.preventDefault();
                        }
                    }}
                />
                {searching && <Spinner size={14}/>}
            </div>
            {open && (suggestions.length > 0 || typedEmail) && (
                <ul
                    className='mml-picker__menu'
                    role='listbox'
                >
                    {suggestions.map((sg, i) => (
                        <React.Fragment key={sg.key}>
                            {(i === 0 || suggestions[i - 1].group !== sg.group) && (
                                <li
                                    className='mml-picker__group'
                                    role='presentation'
                                >
                                    {groupTitle(sg.group, Boolean(text.trim()))}
                                </li>
                            )}
                            <li
                                role='option'
                                aria-selected={i === active}
                                className={i === active ? 'mml-picker__option--active' : ''}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    add(sg.participant);
                                }}
                                onMouseEnter={() => setActive(i)}
                            >
                                <PersonAvatar
                                    email={sg.email || ''}
                                    name={sg.label}
                                    userId={sg.userId}
                                    size={28}
                                />
                                <span className='mml-picker__name'>{sg.label}</span>
                                {sg.sub && <span className='mml-muted mml-small mml-picker__email'>{sg.sub}</span>}
                            </li>
                        </React.Fragment>
                    ))}
                    {typedEmail && !suggestions.some((sg) => sg.email === typedEmail.toLowerCase()) && (
                        <li
                            role='option'
                            aria-selected={suggestions.length === 0}
                            className={suggestions.length === 0 ? 'mml-picker__option--active' : ''}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                addEmails(typedEmail);
                            }}
                        >
                            <span className='mml-avatar mml-avatar--lg mml-avatar--mail'>{'@'}</span>
                            <span>{'Добавить '}<strong>{typedEmail}</strong></span>
                        </li>
                    )}
                </ul>
            )}
        </div>
    );
}

// pendingText lets the composer add an address that was typed but not
// confirmed with Enter before "Send" was pressed.
export function parseAddresses(raw: string): Participant[] {
    return raw.split(/[\s,;]+/).map((s) => s.replace(/^<|>$/g, '')).filter(isEmail).map((e) => participantFromEmail(e));
}
