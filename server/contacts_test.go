package main

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

func TestRobots(t *testing.T) {
	for _, robot := range []string{"noreply@mail.ru", "no-reply@vk.com", "do-not-reply@x.ru", "mailer-daemon@corp.ru", "notifications@github.com", "info.noreply@shop.ru"} {
		assert.True(t, reRobot.MatchString(robot), robot)
	}
	for _, person := range []string{"anna@example.ru", "replyman@x.ru", "noreplyev@x.ru", "robotov@x.ru"} {
		assert.False(t, reRobot.MatchString(person), person)
	}
}

func TestRankContacts(t *testing.T) {
	now := time.Now()
	list := []contact{
		{Email: "newsletter@x.ru", Got: 9, Last: now},
		{Email: "boss@x.ru", Sent: 3, Got: 1, Last: now.Add(-time.Hour)},
		{Email: "old@x.ru", Sent: 1, Last: now.Add(-48 * time.Hour)},
		{Email: "fresh@x.ru", Sent: 1, Last: now},
	}
	rankContacts(list)
	assert.Equal(t, []string{"boss@x.ru", "newsletter@x.ru", "fresh@x.ru", "old@x.ru"},
		[]string{list[0].Email, list[1].Email, list[2].Email, list[3].Email}, "people we write to come first; then by recency")
}
