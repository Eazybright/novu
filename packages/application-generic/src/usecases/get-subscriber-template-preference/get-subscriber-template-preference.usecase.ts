import { Injectable } from '@nestjs/common';
import {
  NotificationTemplateEntity,
  SubscriberPreferenceRepository,
  SubscriberRepository,
  SubscriberEntity,
  MessageTemplateRepository,
} from '@novu/dal';
import { ChannelTypeEnum } from '@novu/stateless';
import { IPreferenceChannels, StepTypeEnum } from '@novu/shared';

import {
  IGetSubscriberPreferenceTemplateResponse,
  ISubscriberPreferenceResponse,
} from '../get-subscriber-preference';
import { GetSubscriberTemplatePreferenceCommand } from './get-subscriber-template-preference.command';
import { ApiException } from '../../utils/exceptions';
import { CachedEntity, buildSubscriberKey } from '../../services';

@Injectable()
export class GetSubscriberTemplatePreference {
  constructor(
    private subscriberPreferenceRepository: SubscriberPreferenceRepository,
    private messageTemplateRepository: MessageTemplateRepository,
    private subscriberRepository: SubscriberRepository
  ) {}

  async execute(
    command: GetSubscriberTemplatePreferenceCommand
  ): Promise<ISubscriberPreferenceResponse> {
    const activeChannels = await this.queryActiveChannels(command);
    const subscriber =
      command.subscriber ??
      (await this.subscriberRepository.findBySubscriberId(
        command.environmentId,
        command.subscriberId
      ));
    if (!subscriber) {
      throw new ApiException(`Subscriber ${command.subscriberId} not found`);
    }

    const subscriberPreference =
      await this.subscriberPreferenceRepository.findOne({
        _environmentId: command.environmentId,
        _subscriberId: subscriber._id,
        _templateId: command.template._id,
      });

    const responseTemplate = mapResponseTemplate(command.template);
    const subscriberPreferenceEnabled = subscriberPreference?.enabled ?? true;

    /*
     * if subscriber preference contains all the active steps
     * return subscriber preference
     */
    if (
      subscriberPreferenceIsWhole(
        subscriberPreference?.channels,
        activeChannels
      )
    ) {
      return getResponse(
        responseTemplate,
        subscriberPreferenceEnabled,
        subscriberPreference?.channels,
        activeChannels
      );
    }

    const templatePreference = command.template.preferenceSettings;

    if (templatePreference) {
      if (!subscriberPreference?.channels) {
        /*
         * if there is template preference and not subscriber preference
         * return template preference
         */
        return getResponse(
          responseTemplate,
          subscriberPreferenceEnabled,
          templatePreference,
          activeChannels
        );
      }

      const mergedPreference = Object.assign(
        {},
        templatePreference,
        subscriberPreference.channels
      );

      /*
       * if subscriber preference are partial
       * return template & subscriber preference merged
       * subscriber preference are preferred
       */
      return getResponse(
        responseTemplate,
        subscriberPreferenceEnabled,
        mergedPreference,
        activeChannels
      );
    }

    /*
     * if no preference are found
     * return default
     * made for backward compatibility
     */
    return getNoSettingFallback(responseTemplate, activeChannels);
  }

  private async queryActiveChannels(
    command: GetSubscriberTemplatePreferenceCommand
  ): Promise<ChannelTypeEnum[]> {
    // todo remove the Set initialization in the return - at the moment the check wont be valid for workflow of 2 same channels
    const activeSteps = command.template.steps.filter(
      (step) => step.active === true
    );

    const stepMissingMessageTemplate = activeSteps.some(
      (step) => !step.template
    );

    if (stepMissingMessageTemplate) {
      const messageIds = activeSteps.map((step) => step._templateId);

      const messageTemplates = await this.messageTemplateRepository.find({
        _environmentId: command.environmentId,
        _id: {
          $in: messageIds,
        },
      });

      return [
        ...new Set(
          messageTemplates.map(
            (messageTemplate) => messageTemplate.type
          ) as unknown as ChannelTypeEnum[]
        ),
      ];
    }

    const channels = activeSteps
      .map((item) => item.template.type as StepTypeEnum)
      .reduce<StepTypeEnum[]>((list, channel) => {
        if (list.includes(channel)) {
          return list;
        }
        list.push(channel);

        return list;
      }, []);

    return channels as unknown as ChannelTypeEnum[];
  }

  @CachedEntity({
    builder: (command: { subscriberId: string; _environmentId: string }) =>
      buildSubscriberKey({
        _environmentId: command._environmentId,
        subscriberId: command.subscriberId,
      }),
  })
  private async fetchSubscriber({
    subscriberId,
    _environmentId,
  }: {
    subscriberId: string;
    _environmentId: string;
  }): Promise<SubscriberEntity | null> {
    return await this.subscriberRepository.findBySubscriberId(
      _environmentId,
      subscriberId
    );
  }
}

function filterActiveChannels(
  activeChannels: ChannelTypeEnum[],
  preference?: IPreferenceChannels
): IPreferenceChannels {
  const filteredChannels = Object.assign({}, preference);
  for (const key in preference) {
    if (!activeChannels.some((channel) => channel === key)) {
      delete filteredChannels[key];
    }
  }

  return filteredChannels;
}

function getNoSettingFallback(
  template: IGetSubscriberPreferenceTemplateResponse,
  activeChannels: ChannelTypeEnum[]
): ISubscriberPreferenceResponse {
  return getResponse(
    template,
    true,
    {
      email: true,
      sms: true,
      in_app: true,
      chat: true,
      push: true,
    },
    activeChannels
  );
}

function mapResponseTemplate(
  template: NotificationTemplateEntity
): IGetSubscriberPreferenceTemplateResponse {
  return {
    _id: template._id,
    name: template.name,
    critical: template.critical != null ? template.critical : true,
  };
}

function subscriberPreferenceIsWhole(
  preference?: IPreferenceChannels | null,
  activeChannels?: ChannelTypeEnum[] | null
): boolean {
  if (!preference || !activeChannels) return false;

  return Object.keys(preference).length === activeChannels.length;
}

function getResponse(
  responseTemplate: IGetSubscriberPreferenceTemplateResponse,
  subscriberPreferenceEnabled: boolean,
  subscriberPreferenceChannels: IPreferenceChannels | undefined,
  activeChannels: ChannelTypeEnum[]
): ISubscriberPreferenceResponse {
  return {
    template: responseTemplate,
    preference: {
      enabled: subscriberPreferenceEnabled,
      channels: filterActiveChannels(
        activeChannels,
        subscriberPreferenceChannels
      ),
    },
  };
}
