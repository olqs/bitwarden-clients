import { TokenService } from "@bitwarden/common/auth/abstractions/token.service";
import { HttpStatusCode } from "@bitwarden/common/enums";
import { CryptoFunctionService } from "@bitwarden/common/platform/abstractions/crypto-function.service";
import { Utils } from "@bitwarden/common/platform/misc/utils";

import { Account } from "./account";
import { Client } from "./client";
import { ClientInfo } from "./client-info";
import { CryptoUtils } from "./crypto-utils";
import { FederatedUserContext } from "./federated-user-context";
import { Parser } from "./parser";
import { ParserOptions } from "./parser-options";
import { RestClient } from "./rest-client";
import { Ui } from "./ui";
import { Provider, UserTypeContext } from "./user-type-context";

export class Vault {
  accounts: Account[];
  userType: UserTypeContext;

  private client: Client;
  private cryptoUtils: CryptoUtils;

  constructor(
    private cryptoFunctionService: CryptoFunctionService,
    private tokenService: TokenService
  ) {
    this.cryptoUtils = new CryptoUtils(cryptoFunctionService);
    const parser = new Parser(cryptoFunctionService, this.cryptoUtils);
    this.client = new Client(parser, this.cryptoUtils);
  }

  async open(
    username: string,
    password: string,
    clientInfo: ClientInfo,
    ui: Ui,
    parserOptions: ParserOptions = ParserOptions.default
  ): Promise<void> {
    this.accounts = await this.client.openVault(username, password, clientInfo, ui, parserOptions);
  }

  async openFederated(
    federatedUser: FederatedUserContext,
    clientInfo: ClientInfo,
    ui: Ui,
    parserOptions: ParserOptions = ParserOptions.default
  ): Promise<void> {
    if (federatedUser == null) {
      throw "Federated user context is not set.";
    }
    const k1 = await this.getK1(federatedUser);
    const k2 = await this.getK2(federatedUser);
    const hiddenPasswordArr = await this.cryptoFunctionService.hash(
      this.cryptoUtils.ExclusiveOr(k1, k2),
      "sha256"
    );
    const hiddenPassword = Utils.fromBufferToB64(hiddenPasswordArr);
    await this.open(federatedUser.username, hiddenPassword, clientInfo, ui, parserOptions);
  }

  async setUserTypeContext(username: string) {
    const lowercaseUsername = username.toLowerCase();
    const rest = new RestClient();
    rest.baseUrl = "https://lastpass.com";
    const endpoint = "lmiapi/login/type?username=" + encodeURIComponent(lowercaseUsername);
    const response = await rest.get(endpoint);
    if (response.status === HttpStatusCode.Ok) {
      const json = await response.json();
      this.userType = new UserTypeContext();
      this.userType.CompanyId = json.CompanyId;
      this.userType.IdentityProviderGUID = json.IdentityProviderGUID;
      this.userType.IdentityProviderURL = json.IdentityProviderURL;
      this.userType.IsPasswordlessEnabled = json.IsPasswordlessEnabled;
      this.userType.OpenIDConnectAuthority = json.OpenIDConnectAuthority;
      this.userType.OpenIDConnectClientId = json.OpenIDConnectClientId;
      this.userType.PkceEnabled = json.PkceEnabled;
      this.userType.Provider = json.Provider;
      this.userType.type = json.type;
    }
    throw "Cannot determine LastPass user type.";
  }

  private async getK1(federatedUser: FederatedUserContext): Promise<Uint8Array> {
    if (this.userType == null) {
      throw "User type is not set.";
    }

    if (!this.userType.isFederated()) {
      throw "Cannot get k1 for LastPass user that is not federated.";
    }

    if (federatedUser == null) {
      throw "Federated user is not set.";
    }

    let k1: Uint8Array = null;
    if (federatedUser.idpUserInfo?.LastPassK1 !== null) {
      return Utils.fromByteStringToArray(federatedUser.idpUserInfo.LastPassK1);
    } else if (this.userType.Provider === Provider.Azure) {
      k1 = await this.getK1Azure(federatedUser);
    } else if (this.userType.Provider === Provider.Google) {
      k1 = await this.getK1Google(federatedUser);
    } else {
      const b64Encoded = this.userType.Provider === Provider.PingOne;
      k1 = this.getK1FromAccessToken(federatedUser, b64Encoded);
    }

    if (k1 !== null) {
      return k1;
    }

    throw "Cannot get k1.";
  }

  private async getK1Azure(federatedUser: FederatedUserContext) {
    // Query the Graph API for the k1 field
    const rest = new RestClient();
    rest.baseUrl = "https://graph.microsoft.com";
    const response = await rest.get(
      "v1.0/me?$select=id,displayName,mail&$expand=extensions",
      new Map([["Authorization", "Bearer " + federatedUser.accessToken]])
    );
    if (response.status === HttpStatusCode.Ok) {
      const json = await response.json();
      const k1 = json?.extensions?.LastPassK1 as string;
      if (k1 !== null) {
        return Utils.fromB64ToArray(k1);
      }
    }
    return null;
  }

  private async getK1Google(federatedUser: FederatedUserContext) {
    // Query Google Drive for the k1.lp file
    const accessTokenAuthHeader = new Map([
      ["Authorization", "Bearer " + federatedUser.accessToken],
    ]);
    const rest = new RestClient();
    rest.baseUrl = "https://content.googleapis.com";
    const response = await rest.get(
      "drive/v3/files?pageSize=1" +
        "&q=name%20%3D%20%27k1.lp%27" +
        "&spaces=appDataFolder" +
        "&fields=nextPageToken%2C%20files(id%2C%20name)",
      accessTokenAuthHeader
    );
    if (response.status === HttpStatusCode.Ok) {
      const json = await response.json();
      const files = json?.files as any[];
      if (files !== null && files.length > 0 && files[0].id != null && files[0].name === "k1.lp") {
        // Open the k1.lp file
        rest.baseUrl = "https://www.googleapis.com";
        const response = await rest.get(
          "drive/v3/files/" + files[0].id + "?alt=media",
          accessTokenAuthHeader
        );
        if (response.status === HttpStatusCode.Ok) {
          const k1 = await response.text();
          return Utils.fromB64ToArray(k1);
        }
      }
    }
    return null;
  }

  private getK1FromAccessToken(federatedUser: FederatedUserContext, b64: boolean) {
    const decodedAccessToken = this.tokenService.decodeToken(federatedUser.accessToken);
    const k1 = decodedAccessToken?.LastPassK1 as string;
    if (k1 !== null) {
      return b64 ? Utils.fromB64ToArray(k1) : Utils.fromByteStringToArray(k1);
    }
    return null;
  }

  private async getK2(federatedUser: FederatedUserContext): Promise<Uint8Array> {
    if (this.userType == null) {
      throw "User type is not set.";
    }

    if (!this.userType.isFederated()) {
      throw "Cannot get k2 for LastPass user that is not federated.";
    }

    const rest = new RestClient();
    rest.baseUrl = this.userType.IdentityProviderURL;
    const response = await rest.postJson("federatedlogin/api/v1/getkey", {
      company_id: this.userType.CompanyId,
      id_token: federatedUser.idToken,
    });
    if (response.status === HttpStatusCode.Ok) {
      const json = await response.json();
      const k2 = json?.k2 as string;
      if (k2 !== null) {
        return Utils.fromB64ToArray(k2);
      }
    }
    throw "Cannot get k2.";
  }
}
