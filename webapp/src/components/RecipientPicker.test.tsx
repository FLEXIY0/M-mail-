import {matchContact} from './RecipientPicker';

const c = (email: string, name?: string) => ({email, name, sent: 0, received: 0, last: ''});

describe('matchContact', () => {
    it('finds people by the start of a word', () => {
        expect(matchContact(c('petrova@client.ru', 'Ольга Петрова'), 'пет')).toBe(true);
        expect(matchContact(c('petrova@client.ru', 'Ольга Петрова'), 'ол')).toBe(true);
        expect(matchContact(c('petrova@client.ru', 'Ольга Петрова'), 'petr')).toBe(true);
        expect(matchContact(c('petrova@client.ru', 'Ольга Петрова'), 'client')).toBe(true);
        expect(matchContact(c('boss@example.ru', 'Сергей Иванович'), 'ан')).toBe(false);
        expect(matchContact(c('a.kuznetsov@partner.ru'), 'kuz')).toBe(true);
        expect(matchContact(c('a.kuznetsov@partner.ru'), 'nets')).toBe(true);
        expect(matchContact(c('a.kuznetsov@partner.ru'), 'ne')).toBe(false);
        expect(matchContact(c('x@y.ru'), '')).toBe(true);
    });
});
