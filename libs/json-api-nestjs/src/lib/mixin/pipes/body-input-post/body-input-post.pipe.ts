import {
  UnprocessableEntityException,
  Inject,
  PipeTransform,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import AjvCall, { ValidateFunction } from 'ajv';
import { validate as classValidate } from 'class-validator';

import { PipeMixin, ValidationError } from '../../../types';
import { ResourceRequestObject } from '../../../types-common/request';
import { getEntityName, upperFirstLetter } from '../../../helper';

export class BodyInputPostPipe<Entity> implements PipeTransform {
  protected validateFunction: ValidateFunction<ResourceRequestObject<Entity>>;

  static inject(pip: PipeMixin): void {
    Inject(AjvCall)(pip, 'ajvCall', 1);
  }
  private relationList: Set<string> = this.repository.metadata.relations.reduce(
    (acum, field) => (acum.add(field.propertyName), acum),
    new Set<string>()
  );
  constructor(
    protected repository: Repository<Entity>,
    protected ajvCall: AjvCall
  ) {
    const schemaName = getEntityName(this.repository.target);

    this.validateFunction = this.ajvCall.getSchema<
      ResourceRequestObject<Entity>
    >(`inputBodyPostSchema-${schemaName}`);
  }

  async transform(
    value: ResourceRequestObject<Entity>
  ): Promise<ResourceRequestObject<Entity>['data']> {
    const validate = this.validateFunction(value);

    const errorResult: ValidationError[] = [];
    if (!validate) {
      for (const error of this.validateFunction.errors) {
        const errorMsg: string[] = [];
        errorMsg.push(upperFirstLetter(error.message));
        switch (error.keyword) {
          case 'enum':
            errorMsg.push(
              `Allowed values are: "${error.params.allowedValues.join(',')}"`
            );
            break;
          case 'additionalProperties':
            errorMsg.push(
              `Additional Property is: "${error.params.additionalProperty}"`
            );
            break;
        }
        errorResult.push({
          source: {
            parameter: error.instancePath,
          },
          detail: errorMsg.join('. '),
        });
      }
    }

    if (errorResult.length > 0) {
      throw new UnprocessableEntityException(errorResult);
    }

    const temporaryEntity = Object.assign(
      // @ts-ignore
      new this.repository.target(),
      value.data.attributes,
      Object.keys(value.data.relationships || {}).reduce((acum, key) => {
        acum[key] = value.data.relationships[key].data;
        return acum;
      }, {})
    );

    const validationErrors = await classValidate(temporaryEntity, {
      skipUndefinedProperties: false,
      forbidUnknownValues: false
    });

    if (validationErrors.length > 0) {
      for (const errorItem of validationErrors) {
        const errorsList = Object.values(errorItem.constraints).map(
          (message) => {
            const error: ValidationError = {
              source: { pointer: `/data/attributes/${errorItem.property}` },
              detail: upperFirstLetter(message),
            };
            if (this.relationList.has(errorItem.property)) {
              error.source.pointer = `/data/relationships/${errorItem.property}`;
            }
            return error;
          }
        );

        errorResult.push(...errorsList);
      }
    }

    if (errorResult.length > 0) {
      throw new UnprocessableEntityException(errorResult);
    }

    const dateKey = Object.keys(value.data.attributes).filter(
      (i) =>
        Reflect.getMetadata(
          'design:type',
          this.repository.target['prototype'],
          i
        ) === Date
    );

    for (const dateField of dateKey) {
      value.data.attributes[dateField] = new Date(
        value.data.attributes[dateField]
      );
    }
    return value.data;
  }
}
