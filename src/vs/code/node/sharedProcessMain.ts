/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as platform from 'vs/base/common/platform';
import { serve, Server, connect } from 'vs/base/parts/ipc/node/ipc.net';
import { TPromise } from 'vs/base/common/winjs.base';
import { registerAIChannel } from 'vs/base/parts/ai/node/ai.app';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { InstantiationService } from 'vs/platform/instantiation/common/instantiationService';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { EnvironmentService } from 'vs/platform/environment/node/environmentService';
import { IEventService } from 'vs/platform/event/common/event';
import { EventService } from 'vs/platform/event/common/eventService';
import { ExtensionManagementChannel } from 'vs/platform/extensionManagement/common/extensionManagementIpc';
import { IExtensionManagementService } from 'vs/platform/extensionManagement/common/extensionManagement';
import { ExtensionManagementService } from 'vs/platform/extensionManagement/node/extensionManagementService';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { NodeConfigurationService } from 'vs/platform/configuration/node/nodeConfigurationService';

import product from 'vs/platform/product';
import { ITelemetryAppender, combinedAppender, ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { TelemetryService, ITelemetryServiceConfig } from 'vs/platform/telemetry/common/telemetryService';
import { AppInsightsAppender } from 'vs/platform/telemetry/node/aiAdapter';

function quit(err?: Error) {
	if (err) {
		console.error(err.stack || err);
	}

	process.exit(err ? 1 : 0);
}

/**
 * Plan B is to kill oneself if one's parent dies. Much drama.
 */
function setupPlanB(parentPid: number): void {
	setInterval(function () {
		try {
			process.kill(parentPid, 0); // throws an exception if the main process doesn't exist anymore.
		} catch (e) {
			process.exit();
		}
	}, 5000);
}

const eventPrefix = 'monacoworkbench';

function createAppender(): ITelemetryAppender {
	const result: ITelemetryAppender[] = [];
	const { key, asimovKey } = product.aiConfig || { key: null, asimovKey: null };

	if (key) {
		result.push(new AppInsightsAppender(eventPrefix, null, key));
	}

	if (asimovKey) {
		result.push(new AppInsightsAppender(eventPrefix, null, asimovKey));
	}

	return combinedAppender(...result);
}

function main(server: Server): void {
	const services = new ServiceCollection();

	services.set(IEventService, new SyncDescriptor(EventService));
	services.set(IEnvironmentService, new SyncDescriptor(EnvironmentService));
	services.set(IExtensionManagementService, new SyncDescriptor(ExtensionManagementService));
	services.set(IConfigurationService, new SyncDescriptor(NodeConfigurationService));

	const instantiationService = new InstantiationService(services);

	instantiationService.invokeFunction(accessor => {
		const { appRoot, extensionsPath } = accessor.get(IEnvironmentService);

		const appender = createAppender();
		const config: ITelemetryServiceConfig = {
			appender,
			commonProperties: TPromise.as({}), //resolveCommonProperties(storageService, contextService),
			piiPaths: [appRoot, extensionsPath]
		};

		const services = new ServiceCollection();
		services.set(ITelemetryService, new SyncDescriptor(TelemetryService, config));
		const instantiationService2 = instantiationService.createChild(services);

		instantiationService2.invokeFunction(accessor => {
			const telemetryService = accessor.get(ITelemetryService);
			console.log(telemetryService);

			const extensionManagementService = accessor.get(IExtensionManagementService);
			const channel = new ExtensionManagementChannel(extensionManagementService);
			server.registerChannel('extensions', channel);
			registerAIChannel(server);

			// eventually clean up old extensions
			setTimeout(() => (extensionManagementService as ExtensionManagementService).removeDeprecatedExtensions(), 5000);
		});
	});
}

function setupIPC(hook: string): TPromise<Server> {
	function setup(retry: boolean): TPromise<Server> {
		return serve(hook).then(null, err => {
			if (!retry || platform.isWindows || err.code !== 'EADDRINUSE') {
				return TPromise.wrapError(err);
			}

			// should retry, not windows and eaddrinuse

			return connect(hook).then(
				client => {
					// we could connect to a running instance. this is not good, abort
					client.dispose();
					return TPromise.wrapError(new Error('There is an instance already running.'));
				},
				err => {
					// it happens on Linux and OS X that the pipe is left behind
					// let's delete it, since we can't connect to it
					// and the retry the whole thing
					try {
						fs.unlinkSync(hook);
					} catch (e) {
						return TPromise.wrapError(new Error('Error deleting the shared ipc hook.'));
					}

					return setup(false);
				}
			);
		});
	}

	return setup(true);
}

function handshake(): TPromise<void> {
	return new TPromise<void>((c, e) => {
		process.once('message', c);
		process.once('error', e);
		process.send('hello');
	});
}

TPromise.join<any>([setupIPC(process.env['VSCODE_SHARED_IPC_HOOK']), handshake()])
	.then(r => main(r[0]))
	.then(() => setupPlanB(process.env['VSCODE_PID']))
	.done(null, quit);