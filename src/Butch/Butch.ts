import { Block, Environment, Value, TypeNames } from "./base"
import { 
    FuncBlock, 
    BreakBlock, 
    DeclareBlock, 
    InvokeBlock, 
    ReturnBlock, 
    TextBlock, 
    _dereferenceBlock, __consolelog 
} from "./blocks";
import ExpressionBlock from "./ExpressionBlock"
import { RuntimeError, CompilationError } from "./errors"; 
import { createButchCodesFile } from "./utils";
import { syntaxCheck, prebuildInternalBlocks } from "./middleware.bch"
import ButchObj from "./ButchObj";

import * as rnfs from "react-native-fs"

export class Program extends Block
{
    private globalEnv: Environment;

    constructor() {
        super();
        this.globalEnv = new Environment(this);
    }

    useGlobalVariable(declarator: DeclareBlock) {
        this.pushToContent(declarator);
        declarator.execute(this.globalEnv)
        return this;
    }

    useFunction(name: string, funcBlock: FuncBlock) {
        this.pushToContent(funcBlock);
        this.globalEnv.create(name, new Value(TypeNames.FUNCKBLOCK, funcBlock))
        return this;
    }

    setBlock(newBlock: Block, path: number[]) {
        let node: Block = this;
        for (let i = 0; i < path.length - 1; ++i) {
            node = node.getContent()[path[i]];
        }        
        
        const content = node.getContent();
        content[path[path.length - 1]] = newBlock;
        node.setContent(content);
    }

    protected logicsBody(env: Environment): Value {
        let main: any;
        try {
            main = env.get("main").evaluate(env, TypeNames.FUNCKBLOCK, true);
        } catch(e) {
            RuntimeError.throwIdentifierError(this, "Symbol 'main' must be defined as a function");
        }
        return main.execute(env);
    }

    execute(): Value {
        return super.execute(this.globalEnv);
    }
}

export type BlockInfo = {obj: ButchObj, location: number[]};

export type Middleware = (info: BlockInfo, app: ButchBuilder) => void;

type Builder = (info: BlockInfo) => Block;

export type ExBuilder = (info: BlockInfo, codes: {[key: string]: string}, 
    app: ButchBuilder) => Block;
    
export class ButchBuilder
{
    static unknownBlockError: Error = new Error("Unknown block type to build");

    // codes dictionary 
    private c: {[key: string]: string};
    private builders: Map<string, Builder>;
    private exBuilders: Map<string, ExBuilder>;
    private middlewares: Middleware[];

    constructor(codes: {[key: string]: string}) {
        this.c = codes;

        // bind default builders
        this.builders = new Map<string, Builder>([
            [this.c.invoker, this.buildInvoker],
            [this.c.declare, this.buildDeclare],
            [this.c.function, this.buildFunction],
            
            // style 2 builder : inline anonymos
            [this.c.expression, info => new ExpressionBlock(info.obj.get("value"))],
            [this.c.text, info => new TextBlock(info.obj.get("value"))],
            [this.c.deref, info => new _dereferenceBlock(info.obj.get("name"))],
            [this.c.break, () => BreakBlock],
            [this.c.return, info => new ReturnBlock(info.obj.extension .builtContent[0])],
            [this.c.log, info => new __consolelog(info.obj.extension .builtContent[0])]
        ]);

        this.exBuilders = new Map<string, ExBuilder>();
        this.middlewares = [syntaxCheck, prebuildInternalBlocks];
    }

    useBuilder(type: string, builder: ExBuilder) {
        if (!this.c[type]) throw ButchBuilder.unknownBlockError;
        this.exBuilders.set(this.c[type], builder);
    }

    useCode(name: string/*, code: number*/) {
        if (this.c[name]) throw new Error(`Code name "${name}" is already used`)
        this.c[name] = Object.keys(this.c).length.toString(16);
    }

    useMiddleware(middleware:  Middleware) {
        this.middlewares.push(middleware);
    }

    saveButchCodes(newName: string | undefined = undefined) {
        const keys = Object.keys(this.c)
        let codesSet: string = keys[0];
        for (let i = 1; i < keys.length; ++i) {
            codesSet += "\n" + keys[i];
        }

        const pathToCodesSet = rnfs.DocumentDirectoryPath + `/.bch/${newName ?? "codes"}.set.txt`;
        return rnfs.writeFile(pathToCodesSet, codesSet).then(() => {
            createButchCodesFile(codesSet.split("\n"), rnfs.DocumentDirectoryPath + `/.bch/${newName ?? "codes"}.json`);
        })
    }

    /**
     * only for testing
     * brutely encode named program's string
     */
    encodeNamedProgram(namedProg: string): string {
        Object.entries(this.c).forEach(([key, value]) => {
            namedProg = namedProg.replace(new RegExp("\"" + key + "\"", "g"),
                "\"" + value.toString() + "\"");
        });
        return namedProg.replace(new RegExp("[ \n\r]+", "g"), "");
    }

    private execMiddlewares(info: BlockInfo) {
        for (let i = 0; i < this.middlewares.length; ++i) {
            this.middlewares[i](info, this);
        }
    }

    // style 1 of builder : private prorety 
    private buildDeclare = (info: BlockInfo): DeclareBlock => {
        return new DeclareBlock(info.obj.get("name"), info.obj.extension .builtContent[0]);
    }

    private buildInvoker: Builder = (info: BlockInfo): Block => {
        return new InvokeBlock(info.obj.get("name"), info.obj.extension .builtContent);
    }

    private buildFunction = (info: BlockInfo): FuncBlock => {
        return new FuncBlock(info.obj.extension .builtContent, info.obj.get("nameSeq"));
    }

    buildBlock(info: BlockInfo): Block {
        this.execMiddlewares(info);
        
        let builder = this.exBuilders.get(info.obj.get("type"));
        if (builder) {
            return builder(info, this.c, this);
        } else {
            let builder = this.builders.get(info.obj.get("type"));
            if (builder) return builder(info); 
        }
        CompilationError.throwUnknownBlock(info);
    }

    build(programObj: ButchObj): Program {
        const prog = new Program(); 
        const content = programObj.content() ?? CompilationError.throwInvalidFile();

        for (let i = 0; i < content.length; ++i) {
            const info: BlockInfo = 
                {obj: new ButchObj(content[i], this.c), location: [i]};

            this.execMiddlewares(info);

            switch (content[i][this.c.type]) {
                case this.c.function:
                    prog.useFunction(String(content[i][this.c.name]), this.buildFunction(info));
                    break;
                
                case this.c.declare:
                    prog.useGlobalVariable(this.buildDeclare(info));
                    break;

                default:
                    CompilationError.throwUnknownBlock(info);
            }
        }
        return prog;
    }

    rebuild(prog: Program, programObj: ButchObj, targetPathes: number[][]) {
        targetPathes.forEach(path => {
            const block = this.buildBlock({obj: programObj.goTo(...path), location: path });
            prog.setBlock(block, path)
        });
    }

    getCodes(): {[key: string]: string} {
        return {...this.c};
    }
}

export default Program;
