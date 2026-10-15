import { check, fail, sleep } from 'k6';
import http from 'k6/http';

const baseUrl = (__ENV.BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const vus = Number(__ENV.VUS || 5);
const rampDuration = __ENV.RAMP_DURATION || '30s';
const holdDuration = __ENV.HOLD_DURATION || '1m';
const reportingWaitSeconds = Number(__ENV.REPORTING_WAIT_SECONDS || 20);

if (!Number.isInteger(vus) || vus < 1) {
  throw new Error('VUS must be a positive integer');
}

if (!Number.isInteger(reportingWaitSeconds) || reportingWaitSeconds < 1) {
  throw new Error('REPORTING_WAIT_SECONDS must be a positive integer');
}

export const options = {
  stages: [
    { duration: rampDuration, target: vus },
    { duration: holdDuration, target: vus },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    checks: ['rate>0.95'],
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

let token;
let username;

function jsonHeaders(bearerToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken) {
    headers.Authorization = 'Bearer ' + bearerToken;
  }
  return headers;
}

function registerAndLogin() {
  const suffix = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  username = 'k6_' + suffix + '_' + __VU;
  const password = __ENV.TEST_PASSWORD || 'k6-local-test-password';

  const registration = http.post(
    baseUrl + '/auth/register',
    JSON.stringify({ username, password }),
    { headers: jsonHeaders() }
  );
  if (!check(registration, { 'register returns 201': (res) => res.status === 201 })) {
    fail('Registration failed for ' + username + ': HTTP ' + registration.status);
  }

  const login = http.post(
    baseUrl + '/auth/login',
    JSON.stringify({ username, password }),
    { headers: jsonHeaders() }
  );
  if (!check(login, { 'login returns a token': (res) => res.status === 200 && Boolean(res.json('token')) })) {
    fail('Login failed for ' + username + ': HTTP ' + login.status);
  }

  token = login.json('token');
}

export default function () {
  if (!token) {
    registerAndLogin();
  }

  const headers = jsonHeaders(token);
  const iteration = __ITER + 1;
  const title = 'k6 task ' + username + ' ' + iteration;

  const creation = http.post(
    baseUrl + '/tasks',
    JSON.stringify({ title, description: 'Created by the k6 end-to-end load test' }),
    { headers }
  );
  if (!check(creation, { 'task creation returns 201': (res) => res.status === 201 })) {
    fail('Task creation failed for ' + username + ': HTTP ' + creation.status);
  }
  const taskId = creation.json('id');
  if (!taskId) {
    fail('Task creation returned no ID for ' + username);
  }

  const listing = http.get(baseUrl + '/tasks', { headers });
  if (!check(listing, {
    'task list contains the created task': (res) =>
      res.status === 200 && res.json().some((task) => String(task.id) === String(taskId)),
  })) {
    fail('Task list did not contain task ' + taskId + ' for ' + username);
  }

  const update = http.put(
    baseUrl + '/tasks/' + taskId,
    JSON.stringify({ status: 'done' }),
    { headers }
  );
  if (!check(update, {
    'task update returns done status': (res) => res.status === 200 && res.json('status') === 'done',
  })) {
    fail('Task update failed for ' + username + ': HTTP ' + update.status);
  }

  const deletion = http.del(baseUrl + '/tasks/' + taskId, null, { headers });
  if (!check(deletion, { 'task deletion returns 204': (res) => res.status === 204 })) {
    fail('Task deletion failed for ' + username + ': HTTP ' + deletion.status);
  }

  const expectedEvents = iteration * 3;
  let eventsReported = false;
  for (let attempt = 0; attempt < reportingWaitSeconds; attempt += 1) {
    const summary = http.get(baseUrl + '/reports/summary');
    if (summary.status === 200) {
      const userEvents = summary.json('by_user').find((entry) => entry.username === username);
      if (userEvents && userEvents.count >= expectedEvents) {
        eventsReported = true;
        break;
      }
    }
    sleep(1);
  }

  check(eventsReported, {
    'reporting events are delivered': (reported) => reported,
  });
}
