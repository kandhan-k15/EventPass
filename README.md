# EventPass

A campus event registration and check-in platform that simplifies event management for students and organizers.

Students can explore events, register for seats, and access QR tickets. Organizers can create events, manage registrations, verify attendance, and download reports.

## Live Demo

**[Visit EventPass](https://eventpass-production-bde18e40.up.railway.app)**

## Features

### Students
- Sign up with email OTP verification.
- Log in and reset forgotten passwords using OTP.
- Browse, search, and filter events.
- Register for events or cancel registrations.
- Join a waiting list when an event is full.
- Receive unique QR tickets for registrations.
- View in-app notifications about event updates and cancellations.

### Organizers
- Create, edit, and delete events.
- Restrict events to selected departments.
- Attach Google Forms to events.
- View event participants and registrations.
- Check in participants using QR camera scanning or ticket codes.
- Download attendance reports in CSV format.
- View registration statistics, attendance rates, and department breakdowns.

## Technology Stack

| Component | Technologies |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Backend | Node.js, Express.js |
| Database | SQLite (`node:sqlite`) |
| Authentication | bcryptjs, JSON Web Tokens |
| Email | Nodemailer, Brevo SMTP |
| QR Generation | qrcode |
| QR Scanning | jsQR |
| Deployment | Railway |

## Engineering Highlights

- **Reliable registration:** Database transactions and unique constraints help prevent duplicate registrations and seat-limit issues.
- **Waiting list management:** Cancelled seats can be automatically offered to waiting students.
- **Secure tickets:** Random ticket codes are validated on the server, and check-in is restricted to authorized organizers.
- **Role-based authorization:** Students and organizers have separate permissions.
- **Input protection:** SQL placeholders, safe text rendering, and CSV formula protection help prevent common security issues.
- **Rate limiting:** Authentication and OTP routes include rate limits to reduce abuse.

## Run Locally

### Prerequisites

- Node.js 22.13 or newer
- npm

### Installation

Clone the repository:

```bash
git clone https://github.com/kandhan-k15/EventPass.git
cd EventPass
npm install
```

Create a `.env` file using `.env.example` as a reference.

Configure the following variables:

| Variable | Description |
|---|---|
| `JWT_SECRET` | Random secret used for signing authentication tokens |
| `SMTP_HOST` | Brevo SMTP server hostname |
| `SMTP_PORT` | SMTP port |
| `SMTP_USER` | Brevo SMTP login |
| `SMTP_PASS` | Brevo SMTP key |
| `SMTP_FROM` | Verified sender email address |
| `ORGANIZER_CODE` | Secret code required for organizer registration |

Start the application:

```bash
npm start
```

Open `http://localhost:3000` in your browser.

The SQLite database is created automatically when the application starts.

## Project Structure

```text
EventPass/
│
├── public/             Frontend files
├── screenshots/        Project screenshots
├── server.js           Express server and API routes
├── db.js               SQLite database and schema
├── package.json        Project dependencies and scripts
├── package-lock.json   Dependency lock file
├── .env.example        Environment variable template
├── .gitignore          Git ignore rules
└── README.md           Project documentation
```

## Testing

The project includes API test scripts for authentication, events, registration, check-in, waiting lists, and email functionality.

Some earlier test scripts may require updates to support the email OTP verification flow.

## Roadmap

- Organizer announcements for registered students.
- PDF participation certificates.
- Certificate verification page.
- Email notifications using an authenticated custom domain.

## Credits

Developed by **Kandhan K**, Information Technology Department, Sri Krishna College of Engineering and Technology (SKCET), Coimbatore.

UI concepts were explored using Google Stitch. AI tools were used for development guidance and code review.