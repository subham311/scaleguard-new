# ScaleGuard API Documentation

This document outlines the available backend API endpoints for the ScaleGuard Shopify application. All endpoints are mounted under the `/v1` prefix. 

Protected endpoints require a valid session token (Shopify App Bridge token) sent in the `Authorization` header as a Bearer token.

---

## 1. Health & Status (`/v1/health`)

### Basic Health Check
- **Endpoint**: `GET /v1/health`
- **Auth Required**: No
- **Description**: Returns the basic health status of the application.
- **Response**:
```json
{
  "status": "ok",
  "timestamp": "2023-10-27T10:00:00.000Z",
  "service": "scaleguard-backend"
}
```

### Detailed System Status
- **Endpoint**: `GET /v1/health/status`
- **Auth Required**: No
- **Description**: Returns aggregated system statistics.
- **Response**:
```json
{
  "system": {
    "shops": { "total": 15, "active": 12 },
    "subscriptions": { "total": 10, "active": 8 },
    "data": { "nudges": 120, "analyses": 45 },
    "jobs": { "total": 500, "recent": [] }
  },
  "timestamp": "2023-10-27T10:00:00.000Z"
}
```

---

## 2. Core API (`/v1/api`)

### Dashboard Data
- **Endpoint**: `GET /v1/api/dashboard`
- **Auth Required**: Yes
- **Description**: Retrieves comprehensive dashboard data including shop info, active nudges, recent analyses, and high-level stats.
- **Response**:
```json
{
  "shop": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "domain": "example.myshopify.com",
    "maturityLevel": "LEARNING",
    "lastAnalysisAt": "2023-10-26T15:30:00.000Z",
    "dataCollectedAt": "2023-10-27T08:00:00.000Z",
    "installedAt": "2023-10-01T10:00:00.000Z"
  },
  "subscription": {
    "status": "ACTIVE",
    "plan": "GROWTH",
    "chargeId": "123456789"
  },
  "nudges": [
    {
      "id": "nudge-123",
      "title": "Low Stock Alert",
      "message": "Product X is running low.",
      "confidenceScore": 95,
      "status": "ACTIVE",
      "createdAt": "2023-10-27T09:00:00.000Z"
    }
  ],
  "analyses": [],
  "jobs": [],
  "stats": {
    "totalNudges": 45,
    "totalAnalyses": 12,
    "activeNudgesCount": 1,
    "avgConfidenceScore": 92.5
  }
}
```

### Dismiss Nudge
- **Endpoint**: `POST /v1/api/nudges/:id/dismiss`
- **Auth Required**: Yes
- **Description**: Marks a specific nudge as dismissed.
- **Response**:
```json
{
  "success": true
}
```

### Data Sufficiency Status
- **Endpoint**: `GET /v1/api/data-status`
- **Auth Required**: Yes
- **Description**: Checks if the store has enough historical data for analysis.
- **Response**:
```json
{
  "meetsThreshold": true,
  "reason": null,
  "dataCounts": {
    "orders": 150,
    "products": 45,
    "customers": 120,
    "daysOfData": 30
  },
  "requirements": {
    "minOrders": 10,
    "minProducts": 5,
    "minDays": 7
  },
  "progress": {
    "ordersProgress": 100,
    "productsProgress": 100,
    "daysProgress": 100
  }
}
```

---

## 3. Billing (`/v1/billing`)

### Get Current Subscription
- **Endpoint**: `GET /v1/billing/subscription`
- **Auth Required**: Yes
- **Description**: Fetches the active subscription details and verifies the charge status against the Shopify API.
- **Response**:
```json
{
  "id": "sub-123",
  "shopId": "123e4567-e89b-12d3-a456-426614174000",
  "plan": "GROWTH",
  "status": "ACTIVE",
  "chargeId": "987654321",
  "createdAt": "2023-10-01T10:00:00.000Z"
}
```

### Create Subscription Charge
- **Endpoint**: `POST /v1/billing/create-charge`
- **Auth Required**: Yes
- **Description**: Generates a new Shopify Recurring Application Charge.
- **Request Body**:
```json
{
  "plan": "PRO"
}
```
- **Response**:
```json
{
  "confirmationUrl": "https://example.myshopify.com/admin/charges/123/456/RecurringApplicationCharge/confirm_recurring_application_charge?signature=...",
  "chargeId": "456",
  "message": "A charge for this plan already exists"
}
```

---

## 4. Background Jobs (`/v1/jobs`)

### Get Job Status
- **Endpoint**: `GET /v1/jobs/status`
- **Auth Required**: Yes
- **Description**: Retrieves the status of recent background jobs for the store.
- **Response**:
```json
{
  "jobs": [
    {
      "id": "job-123",
      "jobType": "DATA_SYNC",
      "status": "COMPLETED",
      "createdAt": "2023-10-27T08:00:00.000Z",
      "completedAt": "2023-10-27T08:05:00.000Z"
    }
  ]
}
```

### Trigger Data Sync
- **Endpoint**: `POST /v1/jobs/trigger-sync`
- **Auth Required**: Yes
- **Description**: Manually queues a data sync job.
- **Response**:
```json
{
  "success": true,
  "job": {
    "id": "job-124",
    "jobType": "DATA_SYNC",
    "status": "QUEUED"
  },
  "message": "Data sync job triggered"
}
```

---

## 5. Diagnostics (`/v1/diagnostics`)

*(Note: Diagnostic endpoints are primarily for debugging and administrative tasks)*

### Check OAuth Configuration
- **Endpoint**: `GET /v1/diagnostics/oauth?shop=example.myshopify.com`
- **Auth Required**: No
- **Description**: Validates the OAuth setup, redirect URIs, and token health.

### Check Webhook Registrations
- **Endpoint**: `GET /v1/diagnostics/webhooks?shop=example.myshopify.com`
- **Auth Required**: No
- **Description**: Verifies if GDPR mandatory webhooks are properly registered with Shopify.

### Check App Installation State
- **Endpoint**: `GET /v1/diagnostics/installation?shop=example.myshopify.com`
- **Auth Required**: No
- **Description**: Determines if the app is fully or partially installed, validating the token and webhook readiness.
