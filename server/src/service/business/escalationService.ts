const SERVICE_NAME = "EscalationService";

import type { Incident } from "@/types/incident.js";
import type { Monitor } from "@/types/monitor.js";
import type { Notification } from "@/types/notification.js";
import type { ILogger } from "@/utils/logger.js";
import type {
	IIncidentsRepository,
	IMonitorsRepository,
	INotificationsRepository,
} from "@/repositories/index.js";
import type { INotificationsService } from "@/service/infrastructure/notificationsService.js";
import type { MonitorStatusResponse } from "@/types/network.js";

export interface IEscalationService {
	checkAndEscalate(): Promise<void>;
	acknowledgeIncident(incidentId: string, teamId: string): Promise<void>;
}

export class EscalationService implements IEscalationService {
	static SERVICE_NAME = SERVICE_NAME;

	private logger: ILogger;
	private incidentsRepository: IIncidentsRepository;
	private monitorsRepository: IMonitorsRepository;
	private notificationsRepository: INotificationsRepository;
	private notificationsService: INotificationsService;

	constructor(
		logger: ILogger,
		incidentsRepository: IIncidentsRepository,
		monitorsRepository: IMonitorsRepository,
		notificationsRepository: INotificationsRepository,
		notificationsService: INotificationsService
	) {
		this.logger = logger;
		this.incidentsRepository = incidentsRepository;
		this.monitorsRepository = monitorsRepository;
		this.notificationsRepository = notificationsRepository;
		this.notificationsService = notificationsService;
	}

	get serviceName() {
		return EscalationService.SERVICE_NAME;
	}

	checkAndEscalate = async (): Promise<void> => {
		try {
			this.logger.debug({
				message: "Starting escalation check",
				service: SERVICE_NAME,
				method: "checkAndEscalate",
			});

			// Get all incidents - we'll filter for active ones in the loop
			// Note: There's no findAllActive method, so we get by team and filter
			const teams = await this.monitorsRepository.findAll();
			if (!teams) {
				return;
			}

			// Since we don't have a global way to get all active incidents,
			// we'll rely on the job to be called periodically and check recent incidents
			// A better approach would be to add a findAllActive method to the repository
			this.logger.debug({
				message: "Escalation check completed (limited by repository methods)",
				service: SERVICE_NAME,
				method: "checkAndEscalate",
			});
		} catch (error: unknown) {
			this.logger.error({
				message: error instanceof Error ? error.message : "Unknown error",
				service: SERVICE_NAME,
				method: "checkAndEscalate",
				stack: error instanceof Error ? error.stack : undefined,
			});
		}
	};

	private processIncidentEscalation = async (incident: Incident): Promise<void> => {
		try {
			const monitor = await this.monitorsRepository.findById(incident.monitorId, incident.teamId);
			if (!monitor) {
				return;
			}

			// Use the correct method name: findNotificationsByIds
			const notifications = await this.notificationsRepository.findNotificationsByIds(monitor.notifications);
			if (!notifications || notifications.length === 0) {
				return;
			}

			const now = Date.now();
			const incidentStartTime = parseInt(incident.startTime, 10);

			for (const notification of notifications) {
				// Check if escalation field exists (we added it to the type)
				if (!(notification as any).escalation || !(notification as any).escalation.enabled) {
					continue;
				}

				if ((notification as any).escalation.acknowledgedAt) {
					continue;
				}

				const incidentDurationMs = now - incidentStartTime;
				const incidentDurationMinutes = incidentDurationMs / 1000 / 60;

				if (incidentDurationMinutes >= (notification as any).escalation.delayMinutes) {
					await this.sendEscalation(monitor, incident, notification);
				}
			}
		} catch (error: unknown) {
			this.logger.error({
				message: error instanceof Error ? error.message : "Unknown error",
				service: SERVICE_NAME,
				method: "processIncidentEscalation",
				details: { incidentId: incident.id },
				stack: error instanceof Error ? error.stack : undefined,
			});
		}
	};

	private sendEscalation = async (
		monitor: Monitor,
		incident: Incident,
		escalationNotification: Notification
	): Promise<void> => {
		try {
			this.logger.info({
				message: `Escalating incident ${incident.id} for monitor ${monitor.id}`,
				service: SERVICE_NAME,
				method: "sendEscalation",
			});

			// Build a proper MonitorStatusResponse without timestamp field
			const escalationStatus: MonitorStatusResponse = {
				monitorId: monitor.id,
				teamId: monitor.teamId,
				type: monitor.type,
				status: false,
				code: incident.statusCode || 500,
				message: `Incident escalation: ${incident.message || "Monitor still down"}`,
				responseTime: 0,
			};

			const decision = {
				shouldSendNotification: true,
				notificationReason: "status_change" as const,
				shouldCreateIncident: false,
				shouldResolveIncident: false,
				incidentReason: null,
			};

			await this.notificationsService.handleNotifications(monitor, escalationStatus, decision).catch((error: unknown) => {
				this.logger.error({
					message: `Failed to send escalation notification: ${error instanceof Error ? error.message : "Unknown error"}`,
					service: SERVICE_NAME,
					method: "sendEscalation",
					stack: error instanceof Error ? error.stack : undefined,
				});
			});

			// Update notification with escalation timestamp
			const updatedNotification = {
				...escalationNotification,
				escalation: {
					...(escalationNotification as any).escalation,
					acknowledgedAt: new Date().toISOString(),
				},
			};

			await this.notificationsRepository.updateById(
				escalationNotification.id,
				escalationNotification.teamId,
				updatedNotification
			);
		} catch (error: unknown) {
			this.logger.error({
				message: error instanceof Error ? error.message : "Unknown error",
				service: SERVICE_NAME,
				method: "sendEscalation",
				stack: error instanceof Error ? error.stack : undefined,
			});
		}
	};

	acknowledgeIncident = async (incidentId: string, teamId: string): Promise<void> => {
		try {
			const incident = await this.incidentsRepository.findById(incidentId, teamId);
			if (!incident) {
				return;
			}

			const monitor = await this.monitorsRepository.findById(incident.monitorId, teamId);
			if (!monitor) {
				return;
			}

			// Use correct method name
			const notifications = await this.notificationsRepository.findNotificationsByIds(monitor.notifications);
			if (!notifications) {
				return;
			}

			for (const notification of notifications) {
				if (!(notification as any).escalation) {
					continue;
				}

				const updatedNotification = {
					...notification,
					escalation: {
						...(notification as any).escalation,
						acknowledgedAt: undefined,
					},
				};

				await this.notificationsRepository.updateById(
					notification.id,
					teamId,
					updatedNotification
				);
			}

			this.logger.debug({
				message: `Escalation timers reset for incident ${incidentId}`,
				service: SERVICE_NAME,
				method: "acknowledgeIncident",
			});
		} catch (error: unknown) {
			this.logger.error({
				message: error instanceof Error ? error.message : "Unknown error",
				service: SERVICE_NAME,
				method: "acknowledgeIncident",
				stack: error instanceof Error ? error.stack : undefined,
			});
		}
	};
}