import { T,token } from "./token";
import { SyntaxError,TokenizerError } from "../../error/error";


export class Lexer{
    source:string
    file:string

    token:Array<token>=[]
    index:number
    line:number
    pos:number
    ch:string
    constructor(source:string,filepath:string){
        this.source=source
        this.file=filepath
        this.index=0
        this.line=1
        this.pos=0
        this.ch=this.source[this.index]
    }

    // add the a new token in token list
    push_token(type:string,value:string|Array<string|any>,end_pos:number|null=null):void{
        this.token.push(new token(type,value,this.line,this.pos,end_pos))
    }
    // show the error
    raise_error(message:string,target:string):void{
        throw new TokenizerError(this.file,this.line,message,target)
    }

    move():void{
        this.index+=1
        this.pos+=1
        if (this.index < this.source.length){
            this.ch = this.source[this.index]
        }else{
            this.ch = "\0"
        }
    }

    nx_ch(n:number=1):string|null{
        let tar = this.index + n
        if (tar > this.source.length){
            return null
        }
        return this.source[this.index + n]
    }
    pv_ch(n:number=1):string|null{
        let tar = this.index - n
        if(tar < this.source.length){
            return null
        }
        return this.source[this.index -n]
    }
    
}