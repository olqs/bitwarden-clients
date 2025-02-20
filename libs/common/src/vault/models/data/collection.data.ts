import { CollectionDetailsResponse } from "../response/collection.response";

export class CollectionData {
  id: string;
  organizationId: string;
  name: string;
  externalId: string;
  readOnly: boolean;
  hidePasswords: boolean;

  constructor(response: CollectionDetailsResponse) {
    this.id = response.id;
    this.organizationId = response.organizationId;
    this.name = response.name;
    this.externalId = response.externalId;
    this.readOnly = response.readOnly;
    this.hidePasswords = response.hidePasswords;
  }
}
